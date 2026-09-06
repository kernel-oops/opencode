import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect } from "bun:test"
import { tool } from "ai"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { Snapshot } from "@/snapshot"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { SessionTools } from "@/session/tools"
import { ToolRegistry, type Registered } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const waitFor = <A>(check: Effect.Effect<A | undefined>, message: string) =>
  Effect.gen(function* () {
    const stop = Date.now() + 500
    while (Date.now() < stop) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.fail(new Error(message))
  })

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  Snapshot.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)

const providerErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: { type: "error", value: "provider boom" },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, providerErrorLLM]])
const itProviderError = testEffect(providerErrorEnv)

const executionFirstLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) =>
      Stream.unwrap(
        Effect.promise(async () => {
          const execute = input.tools.task?.execute
          if (!execute) throw new Error("task tool is missing execute")
          const taskInput = {
            description: "Inspect files",
            prompt: "Inspect files read-only",
            subagent_type: "Cat",
          }
          const result = await execute(taskInput, {
            toolCallId: "call_1",
            abortSignal: new AbortController().signal,
            messages: [],
          })
          return Stream.make(
            LLMEvent.toolCall({ id: "call_1", name: "task", input: taskInput }),
            LLMEvent.toolResult({ id: "call_1", name: "task", result: { type: "json", value: result } }),
            LLMEvent.finish({ reason: "stop" }),
          )
        }),
      ),
  }),
)
const executionFirstEnv = LayerNode.compile(root, [...replacements, [LLM.node, executionFirstLLM]])
const itExecutionFirst = testEffect(executionFirstEnv)

const streamFirstLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      const execute = input.tools.task?.execute
      if (!execute) return Stream.fail(new Error("task tool is missing execute"))
      const taskInput = {
        description: "Inspect files",
        prompt: "Inspect files read-only",
        subagent_type: "Cat",
      }
      const result = Stream.fromEffect(
        Effect.promise(() =>
          execute(taskInput, {
            toolCallId: "call_1",
            abortSignal: new AbortController().signal,
            messages: [],
          }),
        ),
      ).pipe(
        Stream.map((value) => LLMEvent.toolResult({ id: "call_1", name: "task", result: { type: "json", value } })),
      )
      return Stream.concat(
        Stream.make(LLMEvent.toolCall({ id: "call_1", name: "task", input: taskInput })),
        Stream.concat(result, Stream.make(LLMEvent.finish({ reason: "stop" }))),
      )
    },
  }),
)
const streamFirstEnv = LayerNode.compile(root, [...replacements, [LLM.node, streamFirstLLM]])
const itStreamFirst = testEffect(streamFirstEnv)

const delayedErrorInput = {
  description: "Inspect files",
  prompt: "Inspect files read-only",
  subagent_type: "Cat",
}
const delayedErrorLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.toolError({
          id: "call-1",
          name: "task",
          message: "task failed",
          error: new Error("task failed"),
        }),
        LLMEvent.toolCall({ id: "call-1", name: "task", input: delayedErrorInput }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const delayedErrorEnv = LayerNode.compile(root, [...replacements, [LLM.node, delayedErrorLLM]])
const itDelayedError = testEffect(delayedErrorEnv)

const doomLoopInput = { command: "echo repeated" }
const doomLoopRequests: PermissionV1.AskInput[] = []
const doomLoopLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        ...["call-1", "call-2", "call-3"].flatMap((id) => [
          LLMEvent.toolCall({ id, name: "bash", input: doomLoopInput }),
          LLMEvent.toolResult({
            id,
            name: "bash",
            result: { type: "json" as const, value: { title: "bash", metadata: {}, output: "done" } },
          }),
        ]),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const doomLoopPermission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) => Effect.sync(() => void doomLoopRequests.push(input)),
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
    captureTurn: () => Effect.void,
    captureUntrusted: () => Effect.void,
    authoriseTaskDelegation: () => Effect.succeed(undefined),
    captureTaskDelegation: () => Effect.void,
    canResumeTask: () => Effect.succeed(false),
  }),
)
const doomLoopEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, doomLoopLLM],
  [Permission.node, doomLoopPermission],
])
const itDoomLoop = testEffect(doomLoopEnv)

const cleanupLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({ stream: () => Stream.make(LLMEvent.finish({ reason: "stop" })) }),
)
const cleanupEnv = LayerNode.compile(root, [...replacements, [LLM.node, cleanupLLM]])
const itCleanup = testEffect(cleanupEnv)

const fragmentFailureLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "thinking" }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textDelta({ id: "text-1", text: "partial" }),
        LLMEvent.providerError({ message: "provider boom" }),
      ),
  }),
)
const fragmentFailureEnv = LayerNode.compile(root, [...replacements, [LLM.node, fragmentFailureLLM]])
const itFragmentFailure = testEffect(fragmentFailureEnv)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.live("session.processor effect tests capture llm input cleanly", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const input = {
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        } satisfies LLM.StreamInput

        const value = yield* handle.process(input)
        const parts = yield* MessageV2.parts(msg.id)
        const calls = yield* llm.calls

        expect(value).toBe("continue")
        expect(calls).toBe(1)
        expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itDoomLoop.live("session.processor doom-loop review receives the accepted tool arguments", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        doomLoopRequests.length = 0
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "repeat")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "repeat" }],
          tools: {},
        })

        expect(doomLoopRequests).toHaveLength(1)
        const request = doomLoopRequests[0]
        expect(request?.permission).toBe("doom_loop")
        expect(request?.metadata).toEqual({ tool: "bash", input: doomLoopInput })
        expect(request?.review?.arguments).toEqual(doomLoopInput)
        expect(request?.review?.action).toEqual({ identity: "bash", arguments: doomLoopInput, complete: false })
      }),
    { config: cfg },
  ),
)

it.live("session.processor effect tests preserve text start time", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const gate = defer<void>()
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            head: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { role: "assistant" } }],
              },
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: { content: "hello" } }],
              },
            ],
            wait: gate.promise,
            tail: [
              {
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                choices: [{ delta: {}, finish_reason: "stop" }],
              },
            ],
          }),
        )

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.TextPart => part.type === "text")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for text part",
        )
        yield* Effect.sleep("20 millis")
        gate.resolve()

        const exit = yield* Fiber.await(run)
        const text = (yield* MessageV2.parts(msg.id)).find((part): part is SessionV1.TextPart => part.type === "text")

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(text?.text).toBe("hello")
        expect(text?.time?.start).toBeDefined()
        expect(text?.time?.end).toBeDefined()
        if (!text?.time?.start || !text.time.end) return
        expect(text.time.start).toBeLessThan(text.time.end)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests stop after token overflow requests compaction", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.text("after", { usage: { input: 100, output: 0 } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const base = yield* provider.getModel(ref.providerID, ref.modelID)
        const mdl = { ...base, limit: { context: 20, output: 10 } }
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("compact")
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(parts.some((part) => part.type === "step-finish")).toBe(true)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests capture reasoning from http mock", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("think").text("done").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.find((part): part is SessionV1.ReasoningPart => part.type === "reasoning")
        const text = parts.find((part): part is SessionV1.TextPart => part.type === "text")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(reasoning?.text).toBe("think")
        expect(text?.text).toBe("done")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests reset reasoning state across retries", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().reason("one").reset(), reply().reason("two").stop())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "reason")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "reason" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const reasoning = parts.filter((part): part is SessionV1.ReasoningPart => part.type === "reasoning")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(reasoning.some((part) => part.text === "two")).toBe(true)
        expect(reasoning.some((part) => part.text === "onetwo")).toBe(false)
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests do not retry unknown json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { error: { message: "no_kv_space" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "json" }],
          tools: {},
        })

        expect(value).toBe("stop")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error?.name).toBe("APIError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry recognized structured json errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(429, { type: "error", error: { type: "too_many_requests" } })
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry json" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry OpenAI-compatible midstream server errors", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(raw({ chunks: [{ error: { type: "server_error", code: "server_error", message: "xxx" } }] }))
        yield* llm.text("after")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry midstream server error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry midstream server error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests retry network_error finish reasons", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(
          raw({
            chunks: [
              {
                id: "chatcmpl-network-error",
                object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "network_error" }],
              },
            ],
          }),
        )
        yield* llm.text("after retry")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry network error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry network error" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(parts.some((part) => part.type === "text" && part.text === "after retry")).toBe(true)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests publish retry status updates", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        yield* llm.error(503, { error: "boom" })
        yield* llm.text("")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "retry")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const states: number[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== SessionStatus.Event.Status.type) return Effect.void
          const data = evt.data as typeof SessionStatus.Event.Status.data.Type
          if (data.sessionID === chat.id && data.status.type === "retry") states.push(data.status.attempt)
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "retry" }],
          tools: {},
        })

        yield* off

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(2)
        expect(states).toStrictEqual([1])
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests compact on structured context overflow", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.error(400, { type: "error", error: { code: "context_length_exceeded" } })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "compact json")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "compact json" }],
          tools: {},
        })

        expect(value).toBe("compact")
        expect(yield* llm.calls).toBe(1)
        expect(handle.message.error).toBeUndefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests complete AI SDK tool calls when native flag is off", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.tool("lookup", { query: "weather" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tool" }],
          tools: {
            lookup: tool({
              description: "Look up information",
              inputSchema: z.object({ query: z.string() }),
              execute: async (input) => ({
                title: "Weather lookup",
                output: `result:${input.query}`,
                metadata: { source: "test" },
              }),
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("lookup")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status !== "completed") return
        expect(call.state.input).toEqual({ query: "weather" })
        expect(call.state.output).toBe("result:weather")
        expect(call.state.title).toBe("Weather lookup")
        expect(call.state.metadata).toEqual({ source: "test" })
        expect(call.state.time.start).toBeDefined()
        expect(call.state.time.end).toBeDefined()
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor keeps delayed AI SDK Task input separate from plugin execution input", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const providerInput = {
          description: "Inspect files",
          prompt: "Inspect files read-only",
          subagent_type: "Cat",
        }
        const executionInput = { ...providerInput, prompt: "Inspect files after plugin mutation", plugin: true }
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "delegate")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        let executed: Record<string, unknown> | undefined
        let pluginArgs: Record<string, unknown> | undefined
        let executedBeforeStreamPersistence = false
        const fakePlugin = Plugin.Service.of({
          init: () => Effect.void,
          list: () => Effect.succeed([]),
          trigger: (name, _input, output) =>
            Effect.gen(function* () {
              if (name === "tool.execute.before") {
                const before = yield* MessageV2.parts(msg.id).pipe(Effect.provideService(Database.Service, database))
                executedBeforeStreamPersistence = !before.some(
                  (part) => part.type === "tool" && part.callID === "call_1" && part.state.status !== "pending",
                )
                pluginArgs = (output as { args: Record<string, unknown> }).args
                pluginArgs.prompt = executionInput.prompt
                pluginArgs.plugin = true
              }
              return output
            }),
          preparePermissionAsk: () => Effect.succeed(undefined),
        } satisfies Plugin.Interface)
        const fakeRegistry = ToolRegistry.Service.of({
          ids: () => Effect.succeed(["task"]),
          all: () => Effect.succeed([]),
          named: () => Effect.die("unused"),
          tools: () =>
            Effect.succeed<Registered[]>([
              {
                id: "task",
                builtin: true,
                description: "Delegate work",
                parameters: Schema.Struct({
                  description: Schema.String,
                  prompt: Schema.String,
                  subagent_type: Schema.String,
                }),
                jsonSchema: {
                  type: "object",
                  properties: {
                    description: { type: "string" },
                    prompt: { type: "string" },
                    subagent_type: { type: "string" },
                  },
                  required: ["description", "prompt", "subagent_type"],
                },
                execute: (value, ctx) =>
                  Effect.gen(function* () {
                    const input = value as Record<string, unknown>
                    executed = input
                    const metadata = { sessionId: "ses_child" }
                    yield* ctx.metadata({ title: input.description as string, metadata })
                    return { title: input.description as string, metadata, output: "done" }
                  }),
              },
            ]),
        })
        const fakeMcp = MCP.Service.of({
          tools: () => Effect.succeed({}),
          clients: () => Effect.succeed({}),
        } as Partial<MCP.Interface> as MCP.Interface)
        const fakePermission = Permission.Service.of({
          ask: () => Effect.void,
          reply: () => Effect.void,
          list: () => Effect.succeed([]),
          captureTurn: () => Effect.void,
          captureUntrusted: () => Effect.void,
          authoriseTaskDelegation: () => Effect.succeed(undefined),
          captureTaskDelegation: () => Effect.void,
          canResumeTask: () => Effect.succeed(false),
        })
        const fakeTruncate = Truncate.Service.of({
          cleanup: () => Effect.void,
          write: () => Effect.succeed("output.txt"),
          output: (text: string) => Effect.succeed({ content: text, truncated: false }),
          limits: () => Effect.succeed({ maxLines: 2_000, maxBytes: 50 * 1_024 }),
        } satisfies Truncate.Interface)

        yield* llm.tool("task", providerInput)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const tools = yield* SessionTools.resolve({
          agent: agent(),
          model: mdl,
          session: chat,
          processor: handle,
          bypassAgentCheck: false,
          messages: [],
          promptOps: {} as never,
        }).pipe(
          Effect.provideService(Plugin.Service, fakePlugin),
          Effect.provideService(Permission.Service, fakePermission),
          Effect.provideService(ToolRegistry.Service, fakeRegistry),
          Effect.provideService(MCP.Service, fakeMcp),
          Effect.provideService(Truncate.Service, fakeTruncate),
          Effect.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
        )

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "delegate" }],
          tools,
        })

        const calls = (yield* MessageV2.parts(msg.id)).filter(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === "call_1",
        )
        expect(value).toBe("continue")
        expect(yield* llm.calls).toBe(1)
        expect(executedBeforeStreamPersistence).toBe(true)
        expect(pluginArgs).toEqual(executionInput)
        expect(executed).toEqual(executionInput)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.state.status).toBe("completed")
        if (calls[0]?.state.status === "completed") {
          expect(calls[0].state.input).toEqual(executionInput)
          expect(calls[0].state.metadata).toEqual({ sessionId: "ses_child" })
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itExecutionFirst.live("session.processor registers an executing Task before its SDK stream event is persisted", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const taskInput = {
          description: "Inspect files",
          prompt: "Inspect files read-only",
          subagent_type: "Cat",
        }
        const childLink = { sessionId: "ses_child", model: { providerID: "test", modelID: "test-model" } }

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "delegate")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })
        let executedBeforeStreamPersistence = false
        let readyBeforeMetadata = false

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "delegate" }],
          tools: {
            task: tool({
              description: "Delegate work",
              inputSchema: z.object({
                description: z.string(),
                prompt: z.string(),
                subagent_type: z.string(),
              }),
              execute: async (input, options) => {
                const executionInput = { ...input, prompt: "Inspect files after asynchronous plugin mutation" }
                await Promise.resolve()
                const before = await Effect.runPromise(
                  MessageV2.parts(msg.id).pipe(Effect.provideService(Database.Service, database)),
                )
                executedBeforeStreamPersistence = !before.some(
                  (part) => part.type === "tool" && part.callID === options.toolCallId,
                )
                await Effect.runPromise(
                  handle.ensureToolCallReady({
                    toolCallID: options.toolCallId,
                    tool: "task",
                    providerInput: input,
                    executionInput,
                  }),
                )
                const ready = await Effect.runPromise(
                  MessageV2.parts(msg.id).pipe(Effect.provideService(Database.Service, database)),
                )
                const call = ready.find(
                  (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === options.toolCallId,
                )
                readyBeforeMetadata =
                  call?.state.status === "running" &&
                  call.tool === "task" &&
                  JSON.stringify(call.state.input) === JSON.stringify(executionInput)
                await Effect.runPromise(
                  handle.updateToolCall(options.toolCallId, (part) => {
                    if (part.state.status !== "running") return part
                    return {
                      ...part,
                      state: { ...part.state, title: executionInput.description, metadata: childLink },
                    }
                  }),
                )
                const result = { title: executionInput.description, output: "done", metadata: childLink }
                await Effect.runPromise(handle.completeToolCall(options.toolCallId, result))
                return result
              },
            }),
          },
        })

        const parts = yield* MessageV2.parts(msg.id)
        const taskParts = parts.filter(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === "call_1",
        )
        expect(taskParts).toHaveLength(1)
        const call = taskParts[0]
        expect(executedBeforeStreamPersistence).toBe(true)
        expect(readyBeforeMetadata).toBe(true)
        expect(value).toBe("continue")
        expect(call?.callID).toBe("call_1")
        expect(call?.tool).toBe("task")
        expect(call?.state.status).toBe("completed")
        if (call?.state.status === "completed") {
          expect(call.state.input).toEqual({ ...taskInput, prompt: "Inspect files after asynchronous plugin mutation" })
          expect(call.state.metadata).toEqual(childLink)
        }
      }),
    { config: cfg },
  ),
)

itStreamFirst.live("session.processor binds asynchronous Task plugin input after its stream event", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()
        const providerInput = {
          description: "Inspect files",
          prompt: "Inspect files read-only",
          subagent_type: "Cat",
        }
        const executionInput = { ...providerInput, prompt: "Inspect files after asynchronous plugin mutation" }
        const childLink = { sessionId: "ses_child", model: { providerID: "test", modelID: "test-model" } }
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "delegate")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        let streamPersistedProviderInput = false
        let executionBindingPersisted = false

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "delegate" }],
          tools: {
            task: tool({
              description: "Delegate work",
              inputSchema: z.object({ description: z.string(), prompt: z.string(), subagent_type: z.string() }),
              execute: async (input, options) => {
                await Promise.resolve()
                const before = await Effect.runPromise(
                  MessageV2.parts(msg.id).pipe(Effect.provideService(Database.Service, database)),
                )
                const streamed = before.find(
                  (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === options.toolCallId,
                )
                streamPersistedProviderInput =
                  streamed?.state.status === "running" &&
                  JSON.stringify(streamed.state.input) === JSON.stringify(providerInput)
                await Effect.runPromise(
                  handle.ensureToolCallReady({
                    toolCallID: options.toolCallId,
                    tool: "task",
                    providerInput: input,
                    executionInput,
                  }),
                )
                const bound = await Effect.runPromise(
                  MessageV2.parts(msg.id).pipe(Effect.provideService(Database.Service, database)),
                )
                const call = bound.find(
                  (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === options.toolCallId,
                )
                executionBindingPersisted =
                  call?.state.status === "running" &&
                  JSON.stringify(call.state.input) === JSON.stringify(executionInput)
                await Effect.runPromise(
                  handle.updateToolCall(options.toolCallId, (part) => {
                    if (part.state.status !== "running") return part
                    return { ...part, state: { ...part.state, title: executionInput.description, metadata: childLink } }
                  }),
                )
                const result = { title: executionInput.description, output: "done", metadata: childLink }
                await Effect.runPromise(handle.completeToolCall(options.toolCallId, result))
                return result
              },
            }),
          },
        })

        const calls = (yield* MessageV2.parts(msg.id)).filter(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === "call_1",
        )
        expect(value).toBe("continue")
        expect(streamPersistedProviderInput).toBe(true)
        expect(executionBindingPersisted).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.state.status).toBe("completed")
        if (calls[0]?.state.status === "completed") {
          expect(calls[0].state.input).toEqual(executionInput)
          expect(calls[0].state.metadata).toEqual(childLink)
        }
      }),
    { config: cfg },
  ),
)

itDelayedError.live("session.processor ignores a delayed duplicate Task event after failure", () =>
  provideTmpdirInstance(
    (directory) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "failed delegation")
        const msg = yield* assistant(chat.id, parent.id, directory)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const childLink = { sessionId: "ses_child" }

        yield* handle.ensureToolCallReady({
          toolCallID: "call-1",
          tool: "task",
          providerInput: delayedErrorInput,
          executionInput: delayedErrorInput,
        })
        yield* handle.updateToolCall("call-1", (part) => {
          if (part.state.status !== "running") return part
          return { ...part, state: { ...part.state, title: delayedErrorInput.description, metadata: childLink } }
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "failed delegation" }],
          tools: {},
        })

        const calls = (yield* MessageV2.parts(msg.id)).filter(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === "call-1",
        )
        expect(value).toBe("continue")
        expect(calls).toHaveLength(1)
        expect(calls[0]?.state.status).toBe("error")
        if (calls[0]?.state.status === "error") {
          expect(calls[0].state.input).toEqual(delayedErrorInput)
          expect(calls[0].state.metadata).toEqual(childLink)
          expect(calls[0].state.error).toBe("task failed")
        }
      }),
    { config: cfg },
  ),
)

it.live("session.processor does not cross-wire parallel Task readiness", () =>
  provideTmpdirInstance(
    (directory) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "parallel delegation")
        const msg = yield* assistant(chat.id, parent.id, directory)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const first = { description: "first", prompt: "one", subagent_type: "Cat" }
        const second = { description: "second", prompt: "two", subagent_type: "Luke" }

        yield* Effect.all(
          [
            handle.ensureToolCallReady({
              toolCallID: "call-first",
              tool: "task",
              providerInput: first,
              executionInput: first,
            }),
            handle.ensureToolCallReady({
              toolCallID: "call-second",
              tool: "task",
              providerInput: second,
              executionInput: second,
            }),
          ],
          { concurrency: "unbounded" },
        )

        const parts = (yield* MessageV2.parts(msg.id)).filter(
          (part): part is SessionV1.ToolPart => part.type === "tool",
        )
        expect(parts).toHaveLength(2)
        expect(parts.find((part) => part.callID === "call-first")?.state).toMatchObject({
          status: "running",
          input: first,
        })
        expect(parts.find((part) => part.callID === "call-second")?.state).toMatchObject({
          status: "running",
          input: second,
        })

        const childLink = {
          parentSessionId: chat.id,
          sessionId: "ses_first_child",
          background: true,
          jobId: "ses_first_child",
        }
        yield* handle.updateToolCall("call-first", (part) => {
          if (part.state.status !== "running") return part
          return { ...part, state: { ...part.state, title: first.description, metadata: childLink } }
        })
        yield* handle.ensureToolCallReady({
          toolCallID: "call-first",
          tool: "task",
          providerInput: first,
          executionInput: first,
        })
        const running = (yield* MessageV2.parts(msg.id)).find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === "call-first",
        )
        expect(running?.state.status).toBe("running")
        if (running?.state.status === "running") expect(running.state.metadata).toEqual(childLink)

        const providerMismatch = yield* handle
          .ensureToolCallReady({
            toolCallID: "call-first",
            tool: "task",
            providerInput: second,
            executionInput: first,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(providerMismatch)).toBe(true)

        const executionMismatch = yield* handle
          .ensureToolCallReady({
            toolCallID: "call-first",
            tool: "task",
            providerInput: first,
            executionInput: second,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(executionMismatch)).toBe(true)

        yield* handle.completeToolCall("call-first", {
          title: first.description,
          output: "done",
          metadata: childLink,
        })
        const completed = (yield* MessageV2.parts(msg.id)).find(
          (part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === "call-first",
        )
        expect(completed?.state.status).toBe("completed")
        if (completed?.state.status === "completed") expect(completed.state.metadata).toEqual(childLink)
      }),
    { config: cfg },
  ),
)

itCleanup.live("session.processor rejects queued Task registration once cleanup is closing", () =>
  provideTmpdirInstance(
    (directory) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const snapshots = yield* Snapshot.Service
        const persistEntered = yield* Deferred.make<void>()
        const persistRelease = yield* Deferred.make<void>()
        const cleanupEntered = yield* Deferred.make<void>()
        const cleanupRelease = yield* Deferred.make<void>()
        const originalUpdatePart = session.updatePart
        const originalTrack = snapshots.track
        const originalPatch = snapshots.patch
        Object.assign(session, {
          updatePart: (part: SessionV1.Part) => {
            const update = originalUpdatePart(part)
            if (part.type !== "tool" || part.callID !== "call-held" || part.state.status !== "running") return update
            return Deferred.succeed(persistEntered, undefined).pipe(
              Effect.andThen(Deferred.await(persistRelease)),
              Effect.andThen(update),
            )
          },
        })
        Object.assign(snapshots, {
          track: () => Effect.succeed("cleanup-hash"),
          patch: () =>
            Deferred.succeed(cleanupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupRelease)),
              Effect.as({ hash: "cleanup-patch", files: [] }),
            ),
        })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "delegate")
        const msg = yield* assistant(chat.id, parent.id, directory)
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })
        const heldInput = { description: "held", prompt: "one", subagent_type: "Cat" }
        const queuedInput = { description: "queued", prompt: "two", subagent_type: "Luke" }
        const held = yield* handle
          .ensureToolCallReady({
            toolCallID: "call-held",
            tool: "task",
            providerInput: heldInput,
            executionInput: heldInput,
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(persistEntered)

        const queued = yield* handle
          .ensureToolCallReady({
            toolCallID: "call-queued",
            tool: "task",
            providerInput: queuedInput,
            executionInput: queuedInput,
          })
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow

        const processing = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "delegate" }],
            tools: {},
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(cleanupEntered)

        yield* Deferred.succeed(persistRelease, undefined)
        yield* Fiber.join(held)
        const queuedExit = yield* Fiber.await(queued)
        expect(Exit.isFailure(queuedExit)).toBe(true)
        if (Exit.isSuccess(queuedExit)) throw new Error("queued readiness unexpectedly succeeded")
        expect(Cause.squash(queuedExit.cause)).toHaveProperty("message", "Session processor is closing")
        yield* Deferred.succeed(cleanupRelease, undefined)
        expect(yield* Fiber.join(processing)).toBe("continue")

        const calls = (yield* MessageV2.parts(msg.id)).filter(
          (part): part is SessionV1.ToolPart => part.type === "tool",
        )
        expect(calls.map((part) => part.callID)).toEqual(["call-held"])
        expect(calls[0]?.state.status).toBe("error")
        if (calls[0]?.state.status === "error") expect(calls[0].state.metadata?.interrupted).toBe(true)

        Object.assign(session, { updatePart: originalUpdatePart })
        Object.assign(snapshots, { track: originalTrack, patch: originalPatch })
      }),
    { config: cfg },
  ),
)

it.live("session.processor effect tests mark pending tools as aborted on cleanup", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const { processors, session, provider } = yield* boot()

        yield* llm.toolHang("bash", { cmd: "pwd" })

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "tool abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "tool abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* waitFor(
          MessageV2.parts(msg.id).pipe(
            Effect.map((parts) => parts.find((part): part is SessionV1.ToolPart => part.type === "tool")),
            Effect.provideService(Database.Service, database),
          ),
          "timed out waiting for tool part",
        )
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toBe("Tool execution aborted")
          expect(call.state.metadata?.interrupted).toBe(true)
          expect(call.state.time.end).toBeDefined()
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests record aborted errors and idle state", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const seen = defer<void>()
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "abort")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const errs: string[] = []
        const off = yield* events.listen((evt) => {
          if (evt.type !== Session.Event.Error.type) return Effect.void
          const data = evt.data as typeof Session.Event.Error.data.Type
          if (data.sessionID !== chat.id || !data.error) return Effect.void
          errs.push(data.error.name)
          seen.resolve()
          return Effect.void
        })
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "abort" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        yield* Effect.promise(() => seen.promise)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)
        yield* off

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
        expect(errs).toContain("MessageAbortedError")
      }),
    { config: (url) => providerCfg(url) },
  ),
)

it.live("session.processor effect tests mark interruptions aborted without manual abort", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const sts = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "interrupt")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "interrupt" }],
            tools: {},
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)
        yield* Fiber.interrupt(run)

        const exit = yield* Fiber.await(run)
        const stored = yield* MessageV2.get({ sessionID: chat.id, messageID: msg.id })
        const state = yield* sts.get(chat.id)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(handle.message.error?.name).toBe("MessageAbortedError")
        expect(stored.info.role).toBe("assistant")
        if (stored.info.role === "assistant") {
          expect(stored.info.error?.name).toBe("MessageAbortedError")
        }
        expect(state).toMatchObject({ type: "idle" })
      }),
    { config: (url) => providerCfg(url) },
  ),
)

itProviderError.live("session.processor effect tests fail provider-executed error results", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider tool error")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "provider tool error" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe("provider boom")
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(MessageV2.Event.Updated.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)

itFragmentFailure.live("session.processor effect tests retain partial legacy parts without v2 events", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()
        const events = yield* EventV2Bridge.Service

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "provider failure")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const seen: string[] = []
        const off = yield* events.listen((event) => {
          seen.push(event.type)
          return Effect.void
        })
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        expect(
          yield* handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "provider failure" }],
            tools: {},
          }),
        ).toBe("stop")
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        expect(parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "text", text: "partial" }),
            expect.objectContaining({ type: "reasoning", text: "thinking" }),
          ]),
        )
        expect(seen).toContain(MessageV2.Event.PartUpdated.type)
        expect(seen).toContain(Session.Event.Error.type)
        expect(seen.filter((type) => type.startsWith("session.next."))).toEqual([])
      }),
    { config: cfg },
  ),
)
