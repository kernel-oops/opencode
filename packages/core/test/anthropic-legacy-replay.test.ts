import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { ai } from "@opencode/ai/effect"
import { AnthropicMessages } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionLegacy } from "@opencode/schema/session-legacy"
import { Model } from "@opencode/core/model"
import { toLLMMessages } from "../src/session/runner/to-llm-message"

const ref = { providerID: "claude-code", id: "claude-opus-5-5", variant: "medium" } as Model.Ref
const tool = (name: string, id: string, state: unknown, extra = {}) => ({
  type: "tool", id, name, executed: true, providerState: {}, providerResultState: {},
  state, time: { created: 1, ran: 2, completed: 3 }, ...extra,
})
const project = (content: unknown[], extra = {}) => toLLMMessages([SessionLegacy.message("assistant", {
  type: "assistant", id: "msg_fixture", model: ref, content, finish: "stop", ...extra,
}) as unknown as SessionMessage.Assistant], ref, "anthropic")
const compile = (messages: ReturnType<typeof project>) => Effect.runPromise(compileRequest(ai.request({
  model: AnthropicMessages.route.model({ id: "fixture" }), messages, cache: "none", toolChoice: "none",
})))
const completed = { status: "completed", input: { inert: true }, content: [{ type: "text", text: "Synthetic historical result only" }] }

test("diagnosis repro and mixed observed empty-state CLI/native projection compile offline", async () => {
  const repro = project([tool("Bash", "bash", completed)])
  expect(repro[0]!.content.map((part) => part.type)).toEqual(["tool-call", "tool-result"])
  const body: AnthropicMessages.AnthropicMessagesBody = (await compile(repro)).body
  expect(body.messages.map((message) => message.role)).toEqual(["assistant", "user"])
  expect(body.messages[1]!.content[0]).toMatchObject({ type: "tool_result", content: "Synthetic historical result only" })
  const native = ["web_search", "code_execution", "web_fetch"].map((name) => tool(name, name, completed, {
    providerResultState: { blockType: `${name}_tool_result`, result: [{ type: "fixture", name }] },
  }))
  const baseline = (await compile(project(native))).body.messages[0]!.content
  const mixed = (await compile(project([
    ...native, tool("Bash", "bash", completed), tool("ToolSearch", "search", completed),
    tool("mcp__opencode__send_message", "mcp", completed),
    tool("atlassian_searchJiraIssuesUsingJql", "jira", { status: "error", input: {}, error: { type: "fixture", message: "Synthetic failure" }, content: [] }),
  ]))).body
  expect(JSON.stringify(mixed.messages[0]!.content.slice(0, 6))).toBe(JSON.stringify(baseline))
  expect(mixed.messages.at(-1)!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "jira", is_error: true })
})

test("pending executed calls reject and interrupted unknown outcomes remain cautionary text", async () => {
  await expect(compile(project([tool("Bash", "pending", { status: "running", input: {} })]))).rejects.toThrow("cannot safely replay")
  const unknown = project([tool("Bash", "unknown", { status: "error", input: {}, error: { type: "tool.outcome-unknown", message: "Unknown" } })], { interruption: "steer" })
  const body = (await compile(unknown)).body
  expect(JSON.stringify(body)).toContain("Its external outcome is unknown")
  expect(JSON.stringify(body)).toContain("do not assume it did not run or automatically repeat it")
  expect(JSON.stringify(body)).not.toContain("tool_use")
})

test("projection preserves non-empty state for rejection and rejects empty IDs", async () => {
  for (const extra of [
    { providerState: { caller: { type: "code_execution" } } },
    { providerResultState: { futureNativeState: "opaque" } },
  ]) await expect(compile(project([tool("Bash", "state", completed, extra)]))).rejects.toThrow("cannot safely replay")
  await expect(compile(project([tool("Bash", "", completed)]))).rejects.toThrow("cannot safely replay")
  expect((await compile(project([tool("Bash", "valid_id", completed)]))).body.messages[0]!.content[0]).toMatchObject({ id: "valid_id" })
})

const created = DateTime.makeUnsafe(0)
test("interrupted and cross-provider reasoning never compiles to Anthropic assistant text", async () => {
  const assistant = (model: Model.Ref, extra: Partial<SessionMessage.Assistant>, content: SessionMessage.Assistant["content"]) =>
    SessionMessage.Assistant.make({ id: SessionMessage.ID.make("msg_reasoning"), type: "assistant", agent: "build" as never, model, content, time: { created, completed: created }, ...extra })
  const openai = { providerID: "openai", id: "gpt-fixture" } as Model.Ref
  const cases = [
    assistant(ref, { interruption: "steer" }, [
      { type: "reasoning", text: "Hidden thought", native: { signature: "sig" }, time: { created, completed: created } },
      { type: "text", text: "Visible answer" },
    ]),
    ...[{ nativeInterrupted: true }, { nativeObserved: true }].map((native) => assistant(openai, { native: { ...native, completedOutputItems: [
      { type: "reasoning", id: "rs_done", summary: [{ type: "summary_text", text: "Hidden thought" }] },
      { type: "message", id: "msg_done", content: [{ type: "output_text", text: "Visible answer" }] },
    ] } }, [
      { type: "reasoning", text: "Hidden thought", native: { itemId: "rs_done" }, time: { created, completed: created } },
      { type: "text", text: "Visible answer", native: { itemId: "msg_done" } },
    ])),
    // Done receipts without published display parts.
    assistant(openai, { native: { nativeObserved: true, completedOutputItems: [
      { type: "reasoning", id: "rs_done", summary: [{ type: "summary_text", text: "Hidden thought" }] },
      { type: "message", id: "msg_done", content: [{ type: "output_text", text: "Visible answer" }] },
    ] } }, []),
  ]
  for (const message of cases) {
    const messages = toLLMMessages([message], ref, "anthropic")
    const parts = messages.flatMap((item) => item.content)
    expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["Visible answer"])
    expect(parts.some((part) => part.type === "reasoning" && part.text === "Hidden thought")).toBe(true)
    const body: AnthropicMessages.AnthropicMessagesBody = (await compile(messages)).body
    const text = body.messages.flatMap((item) => typeof item.content === "string" ? [item.content] : item.content.flatMap((part) => part.type === "text" ? [part.text] : []))
    expect(text).toEqual(["Visible answer"])
  }
})
