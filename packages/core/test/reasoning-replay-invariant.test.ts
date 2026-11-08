import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { SessionMessage } from "@opencode/core/session/message"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { Agent } from "@opencode/core/agent"
import { DateTime } from "effect"

// Release invariant (upstream #60498): reasoning is never replayed as ordinary text. Every reasoning string below
// starts with SENTINEL and may only appear in a part whose type is "reasoning", whatever the error, interruption,
// finish, native receipt and model-switch state. Do not narrow this matrix to make a merge pass.
const SENTINEL = "REASONING_SENTINEL_"
const created = DateTime.makeUnsafe(0)
const ref = (providerID: string, id: string) => Model.Ref.make({ id: Model.ID.make(id), providerID: Provider.ID.make(providerID) })
const producer = ref("provider", "model")
const targets = { same: producer, otherModel: ref("provider", "other"), otherProvider: ref("other-provider", "model") }

const receipts = {
  none: [],
  display: [{ type: "reasoning", id: "rs_display", summary: [{ type: "summary_text", text: `${SENTINEL}display_receipt` }], encrypted_content: "PROOF_DISPLAY" }],
  orphan: [{ type: "reasoning", id: "rs_orphan", summary: [{ type: "summary_text", text: `${SENTINEL}orphan_receipt` }], encrypted_content: "PROOF_ORPHAN" }],
}
const natives = [
  undefined,
  ...(["nativeInterrupted", "nativeSteered", "nativeAmbiguous", "nativeObserved"] as const).flatMap((flag) =>
    Object.entries(receipts).map(([receipt, items]) => ({ label: `${flag}/${receipt}`, value: { [flag]: true, completedOutputItems: items } })),
  ),
]

const cases = natives.flatMap((native) =>
  [undefined, { type: "unknown" as const, message: "Step failed" }].flatMap((error) =>
    [undefined, "steer" as const].flatMap((interruption) =>
      [undefined, "stop" as const, "length" as const].flatMap((finish) =>
        [true, false].map((completed) => ({ native, error, interruption, finish, completed })),
      ),
    ),
  ),
)

const leaks = (value: unknown, path: string, out: string[], parentType?: unknown) => {
  if (typeof value === "string") {
    if (value.includes(SENTINEL) && parentType !== "reasoning") out.push(`${path}=${JSON.stringify(value)}`)
    return
  }
  if (typeof value !== "object" || value === null) return
  const type = Array.isArray(value) ? undefined : (value as { type?: unknown }).type
  for (const [key, child] of Object.entries(value)) leaks(child, `${path}.${key}`, out, type)
}

describe("reasoning replay invariant", () => {
  test("no reasoning content is ever lowered to ordinary text", () => {
    const violations: string[] = []
    let replayedAsReasoning = 0
    for (const c of cases) {
      const message = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_invariant"),
        type: "assistant",
        agent: Agent.defaultID,
        model: producer,
        content: [
          { type: "text", text: "Answer text", native: { itemId: "msg_answer" } },
          SessionMessage.AssistantReasoning.make({
            type: "reasoning",
            text: `${SENTINEL}display`,
            native: { itemId: "rs_display", reasoningEncryptedContent: "PROOF_LATEST" },
            time: c.completed ? { created, completed: created } : { created },
          }),
        ],
        ...(c.native ? { native: c.native.value } : {}),
        ...(c.error ? { error: c.error } : {}),
        ...(c.interruption ? { interruption: c.interruption } : {}),
        ...(c.finish ? { finish: c.finish } : {}),
        time: { created },
      })
      for (const [target, model] of Object.entries(targets)) {
        const label = `${c.native?.label ?? "plain"} error=${!!c.error} interruption=${c.interruption ?? "-"} finish=${c.finish ?? "-"} completed=${c.completed} target=${target}`
        const messages = toLLMMessages([message], model)
        const found: string[] = []
        leaks(messages, "messages", found)
        for (const leak of found) violations.push(`${label}: ${leak}`)
        if (JSON.stringify(messages).includes(`"type":"reasoning","text":"${SENTINEL}`)) replayedAsReasoning++
      }
    }
    // Guard against a vacuous pass: the matrix must still exercise structured reasoning replay.
    expect(cases.length).toBe(13 * 2 * 2 * 3 * 2)
    expect(replayedAsReasoning).toBeGreaterThan(0)
    expect(violations.slice(0, 20)).toEqual([])
    expect(violations.length).toBe(0)
  })
})
