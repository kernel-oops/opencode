import { expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import { ai } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIResponses } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { NewSessionTool } from "../src/tool/plugin/new-session"
import { definition, execute } from "../src/tool/runtime"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "../src/tool"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Image } from "../src/image"
import { PluginHooks } from "../src/plugin/hooks"
import { testEffect } from "./lib/effect"
import { Location } from "@opencode/core/location"
import { tempLocationLayer } from "./fixture/location"

const registryTests = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, PluginHooks.node]), [
    Location.node.replace(tempLocationLayer),
    Image.node.replace(Layer.mock(Image.Service, { normalize: () => Effect.die("fixture must not execute media") })),
  ]),
)

registryTests.effect("real registry snapshot retains all native inputs plus plugin/MCP fixtures and Code Mode", () =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const names = [
      "edit",
      "glob",
      "grep",
      "new-session",
      "patch",
      "question",
      "read",
      "shell",
      "skill",
      "subagent",
      "webfetch",
      "websearch",
      "write",
    ]
    const modules = yield* Effect.promise(() =>
      Promise.all(names.map((name) => import(`../src/tool/plugin/${name}.ts`))),
    )
    yield* registry.transform((editor) => {
      for (const module of modules)
        editor.add({
          name: module.name,
          description: "Native fixture",
          input: module.Input,
          options: { codemode: false },
          execute: () => Effect.die("never execute native fixtures"),
        })
      editor.add({
        name: "plugin_union",
        description: "Plugin fixture",
        input: { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] },
        options: { codemode: false },
        execute: () => Effect.die("never execute plugin fixture"),
      })
      editor.namespace({ name: "mcp", description: "MCP fixture" })
      editor.add({
        name: "lookup",
        description: "MCP fixture",
        input: Schema.Struct({ query: Schema.String }),
        options: { namespace: "mcp" },
        execute: () => Effect.die("never execute MCP fixture"),
      })
    })
    const snapshot: Tool.Snapshot = yield* registry.snapshot()
    expect(snapshot.definitions).toHaveLength(15)
    expect(snapshot.definitions.map((tool) => tool.name)).toContain("new_session")
    expect(snapshot.definitions.map((tool) => tool.name)).toContain("execute")
    expect(snapshot.definitions.map((tool) => tool.name)).not.toContain("mcp_lookup")
    const before = JSON.stringify(snapshot.definitions)
    const prepared = yield* compileRequest(
      ai.request({
        model: AnthropicMessages.route.model({ id: "fixture" }),
        prompt: "Fixture",
        tools: snapshot.definitions,
        toolChoice: "none",
        cache: "none",
      }),
    )
    const body: AnthropicMessages.AnthropicMessagesBody = prepared.body
    expect(body.tools?.map((tool) => tool.name)).toEqual(snapshot.definitions.map((tool) => tool.name))
    expect(body.tools?.map((tool) => tool.description)).toEqual(
      snapshot.definitions.map((tool) => tool.description),
    )
    for (const tool of body.tools ?? []) {
      expect(tool.input_schema.type).toBe("object")
      for (const key of ["anyOf", "oneOf", "allOf"]) expect(tool.input_schema[key]).toBeUndefined()
    }
    expect(JSON.stringify(snapshot.definitions)).toBe(before)
  }),
)

export const validSessionArguments = [
  {
    operation: "launch",
    launch_key: "fixture",
    title: "Fixture",
    scope: "Fixture scope",
    acceptance: ["Fixture acceptance"],
    ownership_key: "fixture",
    workdir: "/fixture",
  },
  { operation: "status", launch_key: "fixture" },
  { operation: "close", launch_key: "fixture", evidence: "Fixture evidence" },
]

export const invalidSessionArguments = [
  {},
  { launch_key: "fixture" },
  { operation: "status" },
  { operation: "unknown", launch_key: "fixture" },
  ...validSessionArguments.map((value) => ({ ...value, extra: true })),
  ...Object.keys(validSessionArguments[0]).map((key) =>
    Object.fromEntries(Object.entries(validSessionArguments[0]).filter(([name]) => name !== key)),
  ),
  { operation: "close", launch_key: "fixture" },
  { operation: "status", launch_key: "bad key" },
  { operation: "status", launch_key: "x".repeat(121) },
  { operation: "status", launch_key: "" },
  { ...validSessionArguments[0], acceptance: [] },
  { ...validSessionArguments[0], acceptance: Array(21).fill("x") },
  { ...validSessionArguments[0], title: "x".repeat(201) },
  { ...validSessionArguments[0], scope: "x".repeat(12001) },
  { ...validSessionArguments[0], workdir: "x".repeat(4097) },
  { ...validSessionArguments[0], acceptance: [""] },
  { ...validSessionArguments[0], ownership_key: "bad key" },
  { ...validSessionArguments[2], evidence: "x".repeat(4001) },
  "text",
  [],
  null,
]

test("real NewSession Input projects only the Anthropic declaration; original validator gates callbacks", async () => {
  let callbacks = 0
  const tool = {
    name: "new_session",
    description: "Fixture",
    input: NewSessionTool.Input,
    execute: () =>
      Effect.sync(() => {
        callbacks++
        return { content: "fixture" }
      }),
  }
  const original = definition(tool)
  const bytes = JSON.stringify(original.inputSchema)
  expect(original.inputSchema.oneOf).toHaveLength(3)
  const anthropic = await Effect.runPromise(
    compileRequest(
      ai.request({
        model: AnthropicMessages.route.model({ id: "fixture" }),
        prompt: "Fixture",
        tools: [original],
        cache: "none",
      }),
    ),
  )
  expect(anthropic.body.tools?.[0]?.input_schema).toEqual({
    type: "object",
    $schema: original.inputSchema.$schema,
    if: {},
    then: { oneOf: original.inputSchema.oneOf },
  })
  const openai = await Effect.runPromise(
    compileRequest(
      ai.request({
        model: OpenAIResponses.route.model({ id: "fixture" }),
        prompt: "Fixture",
        tools: [original],
        cache: "none",
      }),
    ),
  )
  expect(JSON.stringify(openai.body.tools?.[0]?.parameters)).toBe(
    JSON.stringify({ type: "object", ...original.inputSchema }),
  )
  expect(JSON.stringify(definition(tool).inputSchema)).toBe(bytes)
  const context = {
    sessionID: Session.ID.make("ses_fixture"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_fixture"),
    id: Tool.CallID.make("call_fixture"),
    progress: () => Effect.void,
  }
  for (const input of invalidSessionArguments)
    expect(Exit.isFailure(await Effect.runPromiseExit(execute(tool, input, context)))).toBe(true)
  expect(callbacks).toBe(0)
  for (const input of validSessionArguments)
    expect(Exit.isSuccess(await Effect.runPromiseExit(execute(tool, input, context)))).toBe(true)
  expect(callbacks).toBe(3)
})
