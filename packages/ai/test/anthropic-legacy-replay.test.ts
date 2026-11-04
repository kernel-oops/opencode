import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ai, Message, ToolCallPart, ToolResultPart } from "../src/effect.js"
import * as AnthropicMessages from "../src/protocols/anthropic-messages.js"
import { compileRequest } from "../src/route/client.js"

const compile = (content: Message["content"]) => Effect.runPromise(compileRequest(ai.request({
  model: AnthropicMessages.route.model({ id: "fixture" }),
  messages: [Message.assistant(content)], cache: "none", toolChoice: "none",
})))
const compileHistory = (messages: readonly Message[]) => Effect.runPromise(compileRequest(ai.request({
  model: AnthropicMessages.route.model({ id: "fixture" }), messages, cache: "none", toolChoice: "none",
})))
const pair = (name: string, id: string, error = false) => [
  ToolCallPart.make({ name, id, input: { inert: id }, providerExecuted: true, providerMetadata: { anthropic: {} } }),
  ToolResultPart.make({ name, id, result: error ? { error: { type: "fixture", message: "Synthetic error" }, content: [{ type: "text", text: "Error detail" }] } : `Result ${id}`,
    resultType: error ? "error" : "text", providerExecuted: true, providerMetadata: { anthropic: {} } }),
]
const native = (name: string) => [
  ToolCallPart.make({ name, id: `native_${name}`, input: {}, providerExecuted: true }),
  ToolResultPart.make({ name, id: `native_${name}`, result: { type: "json", value: [] }, providerExecuted: true,
    providerMetadata: { anthropic: { blockType: `${name}_tool_result`, result: [{ type: "fixture", value: name }] } } }),
]

test("mixed executed textual history keeps IDs, names, inputs, errors, text and order; native blocks are byte-identical", async () => {
  const names = ["Bash", "ToolSearch", "mcp__opencode__send_message", "atlassian_searchJiraIssuesUsingJql"]
  const nativeParts = ["web_search", "code_execution", "web_fetch"].flatMap(native)
  const before = (await compile(nativeParts)).body.messages[0]!.content
  const legacy = names.flatMap((name, index) => pair(name, `legacy_${index}`, index === 2))
  const body = (await compile([Message.text("Before"), ...nativeParts, ...legacy, Message.text("After")])).body
  expect(body.messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"])
  expect(JSON.stringify(body.messages[0]!.content.slice(1, 7))).toBe(JSON.stringify(before))
  names.forEach((name, index) => {
    const call = body.messages[index * 2]!.content.at(-1)!
    expect(call).toEqual({ type: "tool_use", id: `legacy_${index}`, name, input: { inert: `legacy_${index}` } })
    const result = body.messages[index * 2 + 1]!.content[0]!
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: `legacy_${index}` })
    if (index === 2) expect(result).toMatchObject({ is_error: true, content: JSON.stringify({ error: { type: "fixture", message: "Synthetic error" }, content: [{ type: "text", text: "Error detail" }] }) })
    else expect(result).toMatchObject({ content: `Result legacy_${index}` })
  })
  expect(body.messages.at(-1)!.content).toEqual([{ type: "text", text: "After", cache_control: undefined }])
})

test("text block results use ordinary lowering without changing text", async () => {
  const [call, result] = pair("Bash", "blocks")
  const body = (await compile([call!, { ...result!, type: "tool-result", result: { type: "content", value: [{ type: "text", text: "  Exact text\n" }] } }])).body
  expect(body.messages[1]!.content[0]).toMatchObject({ content: [{ type: "text", text: "  Exact text\n" }] })
})

test("unsupported, incomplete and ambiguous executed histories fail locally", async () => {
  const [call, result] = pair("Bash", "x")
  const cases: Message["content"][] = [
    [call!], [result!], [result!, call!], [call!, Message.text("separated"), result!],
    [call!, result!, call!, result!],
    [call!, { ...result!, id: "other" }],
    [call!, { ...result!, name: "ToolSearch" }],
    [call!, { ...result!, type: "tool-result", result: { type: "json", value: { server: true } } }],
    [{ ...call!, providerMetadata: { anthropic: { blockType: "server_tool_use" } } }, result!],
    [call!, { ...result!, providerMetadata: { anthropic: { result: [] } } }],
    pair("Bash", "invalid.id"),
    pair("Bash", ""),
    [...pair("Bash", "a.b"), ...pair("ToolSearch", "a_b")],
  ]
  for (const content of cases) await expect(compile(content)).rejects.toThrow("cannot safely replay provider-executed tool")
})

test("only absent or empty provider state is compatible, never reserved native families", async () => {
  for (const name of ["bash_code_execution", "text_editor_code_execution", "tool_search_tool_regex", "mcp_tool_use", "tool_search_future", "mcp_tool_future"]) {
    await expect(compile(pair(name, "reserved"))).rejects.toThrow("cannot safely replay")
  }
  const [call, result] = pair("Bash", "state")
  await expect(compile([{ ...call!, metadata: { caller: "native" } }, result!])).rejects.toThrow("cannot safely replay")
  await expect(compile([call!, { ...result!, metadata: { caller: "native" } }])).rejects.toThrow("cannot safely replay")
  for (const providerMetadata of [
    { anthropic: { caller: { type: "code_execution" } } },
    { anthropic: { futureNativeState: "opaque" } },
    { other: { blockType: "server_tool_use" } },
    { other: { caller: "native" } },
    { anthropic: { result: undefined } },
  ]) {
    await expect(compile([{ ...call!, providerMetadata }, result!])).rejects.toThrow("cannot safely replay")
    await expect(compile([call!, { ...result!, providerMetadata }])).rejects.toThrow("cannot safely replay")
  }
  for (const providerMetadata of [undefined, {}, { anthropic: {} }, { anthropic: {}, other: {} }]) {
    const body = (await compile([{ ...call!, providerMetadata }, { ...result!, providerMetadata }])).body
    expect(body.messages[0]!.content[0]).toMatchObject({ type: "tool_use", id: "state" })
  }
})

test("mixed ordinary calls cannot be stranded by compatibility splits", async () => {
  const ordinaryCall = ToolCallPart.make({ id: "local", name: "local", input: {} })
  const ordinaryResult = ToolResultPart.make({ id: "local", name: "local", result: "Local result" })
  for (const content of [
    [ordinaryCall, ...pair("Bash", "hosted"), Message.text("suffix")],
    [ordinaryCall, ...pair("Bash", "hosted"), ...pair("ToolSearch", "hosted2")],
    [...pair("Bash", "hosted"), ordinaryCall, ...pair("ToolSearch", "hosted2"), Message.text("suffix")],
  ]) await expect(compileHistory([Message.assistant(content), Message.tool(ordinaryResult)])).rejects.toThrow("cannot split an ordinary tool call")
  // Complete ordinary turns before or after the compatibility pair remain valid.
  for (const messages of [
    [Message.assistant([ordinaryCall]), Message.tool(ordinaryResult), Message.assistant(pair("Bash", "hosted"))],
    [Message.assistant([...pair("Bash", "hosted"), ordinaryCall]), Message.tool(ordinaryResult)],
    [Message.assistant([...pair("Bash", "hosted"), ordinaryCall, ...pair("ToolSearch", "hosted2")]), Message.tool(ordinaryResult)],
  ]) expect((await compileHistory(messages)).body.messages.map((message) => message.role)).toEqual(["assistant", "user", "assistant", "user"])
  expect((await compile(pair("Bash", "nonempty_id-1"))).body.messages[0]!.content[0]).toMatchObject({ id: "nonempty_id-1" })
})
