import { describe, expect, test } from "bun:test"
import { LLMRequest } from "@opencode/ai/effect"
import { OpenAIResponses } from "@opencode/ai/protocols"
import { SessionBudgetReasoning } from "@opencode/core/session/context-budget-reasoning"
import { SessionContextBudget } from "@opencode/core/session/context-budget"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { DateTime } from "effect"

const model = SessionRunnerModel.resolved(OpenAIResponses.route.model({ id: "gpt-6.1-sol", provider: "openai" }), {
  limit: { context: 1_000_000, output: 32_000 },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
})
const policy = { target: 400_000, maximum: 480_000 }
const time = { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) }
const source = (id = "one", generated = 20, items = ["rs_one"]) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(`msg_${id}`),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: model.ref,
    time,
    finish: "stop",
    native: { responseId: `resp_${id}` },
    tokens: { input: 100, output: generated - 5, reasoning: 5, cache: { read: 0, write: 0 } },
    content: items.map((item) => ({
      type: "reasoning" as const,
      text: "Visible summary",
      time,
      native: { itemId: item, reasoningEncryptedContent: `ciphertext_${item}` },
    })),
  })
const fixture = (sources = [source()], selected = model) => {
  const inventory = SessionBudgetReasoning.capture({ messages: sources, model: selected })
  const request = new LLMRequest({
    model: selected.model,
    messages: toLLMMessages(sources, selected.ref, "openai"),
    system: [],
    tools: [],
    generation: { maxTokens: 32_000 },
  })
  const input = [
    ...new Map(
      sources.flatMap((message) =>
        message.content
          .filter((part) => part.type === "reasoning")
          .map(
            (part) =>
              [
                part.native!.itemId,
                {
                  type: "reasoning",
                  id: part.native!.itemId,
                  summary: [{ type: "summary_text", text: part.text }],
                  encrypted_content: part.native!.reasoningEncryptedContent,
                },
              ] as const,
          ),
      ),
    ).values(),
  ]
  const body = { max_output_tokens: 32_000, input }
  return {
    inventory,
    request,
    body,
    check: () => SessionContextBudget.assess(policy, request, selected.limit, JSON.stringify(body), inventory),
  }
}

describe("usage-backed ordinary encrypted reasoning replay", () => {
  test("preserves wire ciphertext and adds the full source generation allowance", () => {
    const f = fixture()
    const before = JSON.stringify(f.request)
    const checked = f.check()
    expect(checked.reason).toBeUndefined()
    expect(checked.replayGenerated).toBe(20)
    expect(JSON.stringify(f.request)).toBe(before)
    expect(JSON.stringify(f.body)).toContain("ciphertext_rs_one")
  })
  test("counts multiple items and coalesced summary fragments once per source assistant", () => {
    const f = fixture([source("one", 20, ["rs_a", "rs_b", "rs_a"]), source("two", 40, ["rs_c"])])
    expect(f.check().reason).toBeUndefined()
    expect(f.check().replayGenerated).toBe(60)
  })
  test("takes primitive evidence before hooks can mutate source objects", () => {
    const original = source()
    const f = fixture([original])
    Object.assign(original.content[0].native!, { reasoningEncryptedContent: "changed" })
    expect(f.inventory[0].ciphertext).toBe("ciphertext_rs_one")
  })
  for (const failure of [
    "missing-usage",
    "zero-usage",
    "missing-response",
    "missing-item",
    "unfinished",
    "ambiguous",
    "error",
    "variant",
  ] as const) {
    test(`rejects ${failure} source evidence`, () => {
      const original = source()
      const changed = SessionMessage.Assistant.make({
        ...original,
        ...(failure === "missing-usage" ? { tokens: undefined } : {}),
        ...(failure === "zero-usage" ? { tokens: { ...original.tokens!, output: 0, reasoning: 0 } } : {}),
        ...(failure === "missing-response" ? { native: {} } : {}),
        ...(failure === "ambiguous" ? { native: { ...original.native, nativeAmbiguous: true } } : {}),
        ...(failure === "error" ? { error: { type: "provider.error", message: "failed" } } : {}),
        ...(failure === "unfinished" ? { time: { created: time.created } } : {}),
        ...(failure === "missing-item"
          ? { content: [{ ...original.content[0], native: { reasoningEncryptedContent: "ciphertext_rs_one" } }] }
          : {}),
      })
      const selected =
        failure === "variant" ? { ...model, ref: { ...model.ref, variant: Model.VariantID.make("low") } } : model
      expect(fixture([changed], selected).check().reason).toBeDefined()
    })
  }
  test("rejects substituted ciphertext, duplicate final items and late unprepared injection", () => {
    for (const mode of ["substitution", "duplicate", "injection"] as const) {
      const f = fixture()
      const body = {
        ...f.body,
        input:
          mode === "substitution"
            ? [{ ...f.body.input[0], encrypted_content: "substituted" }]
            : mode === "duplicate"
              ? [f.body.input[0], f.body.input[0]]
              : [...f.body.input, { ...f.body.input[0], id: "rs_unknown" }],
      }
      expect(
        SessionContextBudget.assess(policy, f.request, model.limit, JSON.stringify(body), f.inventory).reason,
      ).toBeDefined()
    }
  })
  test("unmatched encrypted maintenance input cannot borrow another request's usage", () => {
    const f = fixture()
    const untrusted = fixture([source("other", 20, ["rs_other"])])
    expect(
      SessionContextBudget.assess(policy, untrusted.request, model.limit, JSON.stringify(untrusted.body), f.inventory)
        .reason,
    ).toBeDefined()
  })
})
