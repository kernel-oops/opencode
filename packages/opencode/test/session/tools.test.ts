import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry, type Registered } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Exit, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

let taskStarted = () => {}
let beforeExecute = (_output: { args: Record<string, unknown> }): Effect.Effect<void> => Effect.void

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (name, _input, output) =>
    (name === "tool.execute.before" ? beforeExecute(output as { args: Record<string, unknown> }) : Effect.void).pipe(
      Effect.as(output),
    ),
  preparePermissionAsk: () => Effect.succeed(undefined),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
  captureTurn: () => Effect.void,
  captureUntrusted: () => Effect.void,
  authoriseTaskDelegation: () => Effect.succeed(undefined),
  captureTaskDelegation: () => Effect.void,
  canResumeTask: () => Effect.succeed(false),
} satisfies Permission.Interface)

const fakeSession = Session.Service.of({} as Partial<Session.Interface> as Session.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const layer = Layer.mergeAll(
  Layer.succeed(Plugin.Service, fakePlugin),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(Session.Service, fakeSession),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing", "task"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed<Registered[]>([
          {
            id: "timing",
            builtin: true,
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Registered,
          {
            id: "task",
            builtin: true,
            description: "starts a child task",
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
            execute: (_args, ctx) =>
              ctx.metadata({ title: "child", metadata: { sessionId: "child" } }).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    taskStarted()
                    return { title: "task", metadata: { sessionId: "child" }, output: "done" }
                  }),
                ),
              ),
          } satisfies Registered,
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.effect("detaches tool input without coercing values or invoking toJSON", () =>
  Effect.sync(() => {
    let called = false
    const custom = {
      toJSON() {
        called = true
        return "coerced"
      },
    }

    expect(() => SessionProcessor.detachToolInput({ custom })).toThrow("Tool input must be a JSON-serialisable object")
    expect(called).toBe(false)
    expect(() => SessionProcessor.detachToolInput({ value: undefined })).toThrow(
      "Tool input must be a JSON-serialisable object",
    )
    expect(() => SessionProcessor.detachToolInput({ value: Number.NaN })).toThrow(
      "Tool input must be a JSON-serialisable object",
    )
  }),
)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      ensureToolCallReady: () => Effect.succeed(state),
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "ensureToolCallReady" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

it.effect("waits for durable Task registration before publishing metadata or starting the child", () =>
  Effect.gen(function* () {
    const taskInput = { description: "child", prompt: "child", subagent_type: "Cat" }
    const state: SessionV1.ToolPart = {
      id: PartID.ascending(),
      sessionID,
      messageID,
      type: "tool",
      tool: "task",
      callID,
      state: { status: "running", input: taskInput, time: { start: 100 } },
    }
    const events: string[] = []
    taskStarted = () => events.push("child")
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => (entered = resolve))
    const persist = new Promise<void>((resolve) => (release = resolve))
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      ensureToolCallReady: () =>
        Effect.promise(async () => {
          events.push("registration-started")
          entered()
          await persist
          events.push("registration-persisted")
          return state
        }),
      updateToolCall: (_toolCallID: string, update: (part: SessionV1.ToolPart) => SessionV1.ToolPart) =>
        Effect.sync(() => {
          events.push("metadata")
          const next = update(state)
          if (next === state) return undefined
          state.state = next.state
          return state
        }),
      completeToolCall: () => Effect.void,
    }
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.task.execute
    if (!execute) throw new Error("task tool is missing execute")
    const execution = execute(taskInput, {
      toolCallId: callID,
      abortSignal: new AbortController().signal,
      messages: [],
    })

    yield* Effect.promise(() => ready)
    expect(events).toEqual(["registration-started"])
    release()
    yield* Effect.promise(() => execution)
    expect(events).toEqual(["registration-started", "registration-persisted", "metadata", "child"])
  }),
)

it.effect("detaches provider and asynchronously mutated Task execution inputs", () =>
  Effect.gen(function* () {
    const providerInput = { description: "child", prompt: "provider", subagent_type: "Cat" }
    const executionInput = { description: "child", prompt: "plugin", subagent_type: "Cat", plugin: true }
    let release!: () => void
    let entered!: () => void
    const mutationEntered = new Promise<void>((resolve) => (entered = resolve))
    const mutationReleased = new Promise<void>((resolve) => (release = resolve))
    beforeExecute = (output) =>
      Effect.promise(async () => {
        entered()
        await mutationReleased
        output.args.prompt = "plugin"
        output.args.plugin = true
      })
    let captured:
      | {
          providerInput: Record<string, unknown>
          executionInput: Record<string, unknown>
        }
      | undefined
    const state: SessionV1.ToolPart = {
      id: PartID.ascending(),
      sessionID,
      messageID,
      type: "tool",
      tool: "task",
      callID,
      state: { status: "running", input: executionInput, time: { start: 100 } },
    }
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      ensureToolCallReady: (input: {
        providerInput: Record<string, unknown>
        executionInput: Record<string, unknown>
      }) =>
        Effect.sync(() => {
          captured = input
          return state
        }),
      updateToolCall: (_toolCallID: string, update: (part: SessionV1.ToolPart) => SessionV1.ToolPart) =>
        Effect.sync(() => {
          const next = update(state)
          return next === state ? undefined : next
        }),
      completeToolCall: () => Effect.void,
    }
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.task.execute
    if (!execute) throw new Error("task tool is missing execute")
    const execution = execute(providerInput, {
      toolCallId: callID,
      abortSignal: new AbortController().signal,
      messages: [],
    })

    yield* Effect.promise(() => mutationEntered)
    expect(captured).toBeUndefined()
    expect(providerInput).toEqual({ description: "child", prompt: "provider", subagent_type: "Cat" })
    release()
    yield* Effect.promise(() => execution)

    expect(captured?.providerInput).toEqual({ description: "child", prompt: "provider", subagent_type: "Cat" })
    expect(captured?.providerInput).not.toBe(providerInput)
    expect(captured?.executionInput).toEqual(executionInput)
    beforeExecute = () => Effect.void
  }),
)

it.effect("rejects non-JSON Task input produced by a plugin before readiness or child start", () =>
  Effect.gen(function* () {
    let registered = false
    let childStarted = false
    taskStarted = () => {
      childStarted = true
    }
    beforeExecute = (output) =>
      Effect.sync(() => {
        output.args.unsupported = 1n
      })
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      ensureToolCallReady: () =>
        Effect.sync(() => {
          registered = true
          throw new Error("unexpected registration")
        }),
      updateToolCall: () => Effect.die("metadata must not be published"),
      completeToolCall: () => Effect.void,
    }
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.task.execute
    if (!execute) throw new Error("task tool is missing execute")
    const exit = yield* Effect.promise(() =>
      execute(
        { description: "child", prompt: "child", subagent_type: "Cat" },
        { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] },
      ),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(registered).toBe(false)
    expect(childStarted).toBe(false)
    beforeExecute = () => Effect.void
  }),
)

it.effect("does not start a Task child when registration persistence fails", () =>
  Effect.gen(function* () {
    let childStarted = false
    taskStarted = () => {
      childStarted = true
    }
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      ensureToolCallReady: () => Effect.fail(new Error("persistence failed")),
      updateToolCall: () => Effect.die("metadata must not be published"),
      completeToolCall: () => Effect.void,
    }
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.task.execute
    if (!execute) throw new Error("task tool is missing execute")
    const exit = yield* Effect.promise(() =>
      execute(
        { description: "child", prompt: "child", subagent_type: "Cat" },
        { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] },
      ),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(childStarted).toBe(false)
  }),
)

it.effect("does not report Task metadata success for a settled call", () =>
  Effect.gen(function* () {
    const taskInput = { description: "child", prompt: "child", subagent_type: "Cat" }
    let childStarted = false
    taskStarted = () => {
      childStarted = true
    }
    const state: SessionV1.ToolPart = {
      id: PartID.ascending(),
      sessionID,
      messageID,
      type: "tool",
      tool: "task",
      callID,
      state: {
        status: "completed",
        input: taskInput,
        title: "settled",
        metadata: {},
        output: "done",
        time: { start: 100, end: 101 },
      },
    }
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      ensureToolCallReady: () => Effect.succeed(state),
      updateToolCall: (_toolCallID: string, update: (part: SessionV1.ToolPart) => SessionV1.ToolPart) =>
        Effect.sync(() => {
          const next = update(state)
          return next === state ? undefined : next
        }),
      completeToolCall: () => Effect.void,
    }
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.task.execute
    if (!execute) throw new Error("task tool is missing execute")
    const exit = yield* Effect.promise(() =>
      execute(taskInput, {
        toolCallId: callID,
        abortSignal: new AbortController().signal,
        messages: [],
      }),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(childStarted).toBe(false)
  }),
)

it.effect("does not register or start an already-cancelled Task", () =>
  Effect.gen(function* () {
    let registered = false
    let childStarted = false
    taskStarted = () => {
      childStarted = true
    }
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      ensureToolCallReady: () =>
        Effect.sync(() => {
          registered = true
          throw new Error("unexpected registration")
        }),
      updateToolCall: () => Effect.die("metadata must not be published"),
      completeToolCall: () => Effect.void,
    }
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.task.execute
    if (!execute) throw new Error("task tool is missing execute")
    const exit = yield* Effect.promise(() =>
      execute(
        { description: "child", prompt: "child", subagent_type: "Cat" },
        { toolCallId: callID, abortSignal: controller.signal, messages: [] },
      ),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(registered).toBe(false)
    expect(childStarted).toBe(false)
  }),
)
