import { describe, expect, test } from "bun:test"
import { LLMRequest, Message, Media, ToolDefinition, ToolResultPart, SystemPart } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Schema } from "effect"
import { SessionContextBudget } from "@opencode/core/session/context-budget"
import { Policy } from "@opencode/schema/session-context-budget"
import { estimateRequest } from "@opencode/core/session/context-size"
import { Token } from "@opencode/core/util/token"

const policy = { target: 400_000, maximum: 480_000 }
const limit = { context: 1_000_000, output: 32_000 }
const request = (text = "hello") =>
  new LLMRequest({
    model: OpenAIChat.route.model({ id: "fixture", provider: "fixture" }),
    messages: [Message.user(text)],
    system: [],
    tools: [],
    generation: { maxTokens: 32_000 },
  })

describe("estimated total-token admission contract", () => {
  test("validates positive integer policy fields", () => {
    const valid = Schema.is(Policy)
    expect(valid(policy)).toBe(true)
    for (const bad of [
      { target: 0, maximum: 1 },
      { target: 1.5, maximum: 10 },
      { target: 1, maximum: Infinity },
    ])
      expect(valid(bad)).toBe(false)
  })
  for (const text of [
    "Plain English words ".repeat(30),
    "const f=(x:number)=>x**2;\n".repeat(30),
    "日本語🙂é\u0000".repeat(30),
  ]) {
    test(`recounts and margins the declared character estimator (${text.slice(0, 12)})`, () => {
      const sent = request(text)
      const wire = JSON.stringify({ messages: [{ role: "user", content: text }], max_tokens: 32_000 })
      const checked = SessionContextBudget.assess(policy, sent, limit, wire)
      expect(checked.raw).toBe(Math.max(estimateRequest(sent), Token.estimate(wire)))
      expect(checked.input).toBe(Math.ceil(checked.raw * 1.15))
      expect(checked.total).toBe(checked.input + 32_000)
      expect(checked.reason).toBeUndefined()
    })
  }
  test("counts instructions, summaries, schemas and tool results", () => {
    const original = request("<summary>previous work</summary>")
    const sent = LLMRequest.update(original, {
      system: [SystemPart.make("instructions".repeat(100))],
      tools: [
        new ToolDefinition({
          name: "echo",
          description: "description".repeat(100),
          inputSchema: { type: "object", properties: { value: { type: "string", description: "schema".repeat(100) } } },
        }),
      ],
      messages: [
        ...original.messages,
        Message.tool(
          ToolResultPart.make({ id: "call_1", name: "echo", result: { type: "text", value: "result".repeat(100) } }),
        ),
      ],
    })
    expect(SessionContextBudget.assess(policy, sent, limit).raw).toBe(estimateRequest(sent))
    expect(SessionContextBudget.assess(policy, sent, limit).raw).toBeGreaterThan(800)
  })
  test("maximum includes requested output and cannot lower it to pass", () => {
    const sent = request("x".repeat(1_600_000))
    const checked = SessionContextBudget.assess(policy, sent, limit)
    expect(checked).toMatchObject({ raw: 400_000, input: 460_000, output: 32_000, total: 492_000 })
    expect(checked.reason).toContain("Estimated total")
    expect(sent.generation?.maxTokens).toBe(32_000)
  })
  test("intersects smaller models and safe input reserves", () => {
    const sent = request("x".repeat(200_000))
    const checked = SessionContextBudget.assess(policy, sent, { context: 64_000, input: 40_000, output: 32_000 })
    expect(checked).toMatchObject({ maximum: 64_000, inputMaximum: 24_000, output: 32_000 })
    expect(checked.reason).toContain("safe input")
    expect(SessionContextBudget.assess(policy, sent, limit).reason).toBeUndefined()
    const inputBound = SessionContextBudget.assess(policy, request("x".repeat(100_000)), { context: 64_000, input: 40_000, output: 32_000 })
    expect(inputBound.target).toBe(56_000)
    expect(SessionContextBudget.shouldCompact(inputBound, undefined, "smaller-input")).toBe(true)
  })
  test("unknown limits and unknown output reserve fail closed", () => {
    expect(SessionContextBudget.assess(policy, request(), { context: 0, output: 0 }).reason).toContain("unknown")
    expect(
      SessionContextBudget.assess(policy, LLMRequest.update(request(), { generation: undefined }), limit).reason,
    ).toContain("reserve")
    expect(
      SessionContextBudget.assess(policy, request(), limit, JSON.stringify({ max_tokens: null })).reason,
    ).toContain("reserve")
  })
  test("unserialisable tool values fail closed instead of escaping as hook defects", () => {
    const sent = LLMRequest.update(request(), {
      messages: [
        Message.tool(ToolResultPart.make({ id: "call_1", name: "echo", result: { type: "json", value: 1n } })),
      ],
    })
    expect(SessionContextBudget.assess(policy, sent, limit).reason).toContain("not representable")
    const omitted = LLMRequest.update(request(), {
      messages: [
        Message.tool(
          ToolResultPart.make({ id: "call_2", name: "echo", result: { type: "json", value: { callback: () => 1 } } }),
        ),
      ],
    })
    expect(SessionContextBudget.assess(policy, omitted, limit).reason).toContain("not representable")
  })
  test("unrepresented media, native windows, hosted expansion and delta references fail closed", () => {
    const media = LLMRequest.update(request(), {
      messages: [Message.user([{ type: "media", media: Media.base64("YQ==", "image/png") }])],
    })
    expect(SessionContextBudget.assess(policy, media, limit).reason).toContain("opaque")
    const file = LLMRequest.update(request(), {
      messages: [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [{ type: "file", mime: "application/pdf", uri: "https://example.test/file" }],
            },
          }),
        ),
      ],
    })
    expect(SessionContextBudget.assess(policy, file, limit).reason).toContain("opaque")
    for (const hidden of [
      { previous_response_id: "resp_hidden" },
      { conversation: "conv_hidden" },
      { input: [{ type: "compaction", encrypted_content: "hidden" }] },
      { tools: [{ type: "web_search" }] },
      { tools: [{ type: "future_hosted_operation" }] },
      { contents: [{ parts: [{ fileData: { fileUri: "https://example.test/file" } }] }] },
    ])
      expect(
        SessionContextBudget.assess(policy, request(), limit, JSON.stringify({ max_tokens: 32_000, ...hidden })).reason,
      ).toContain("unrepresented")
  })
  test("uses the largest declared outbound output reserve when hooks supply conflicting fields", () => {
    expect(
      SessionContextBudget.assess(
        policy,
        request(),
        limit,
        JSON.stringify({ max_tokens: 1, max_output_tokens: 32_000 }),
      ).output,
    ).toBe(32_000)
  })
  test("late outbound expansion uses the larger representation rather than double-counting", () => {
    const wire = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1_600_000) }], max_tokens: 32_000 })
    const checked = SessionContextBudget.assess(policy, request(), limit, wire)
    expect(checked.raw).toBe(Token.estimate(wire))
    expect(checked.reason).toContain("Estimated total")
  })
  test("latches no progress across ordinary growth; only changed binding or verified shrink re-arms", () => {
    const checked = SessionContextBudget.assess(policy, request("x".repeat(1_400_000)), limit)
    expect(SessionContextBudget.shouldCompact(checked, undefined, "one")).toBe(true)
    const state = { attempted: { binding: "one", estimated: checked.total } }
    expect(SessionContextBudget.shouldCompact({ ...checked, total: checked.total + 10 }, state, "one")).toBe(false)
    expect(SessionContextBudget.shouldCompact(checked, state, "smaller-model")).toBe(true)
    expect(
      SessionContextBudget.shouldCompact(SessionContextBudget.assess(policy, request(), limit), state, "one"),
    ).toBe(false)
  })
})
