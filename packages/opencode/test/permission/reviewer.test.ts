import { expect, spyOn } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { createOpenAI } from "@ai-sdk/openai"
import { Context, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Output, simulateReadableStream, streamText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { Auth } from "@/auth"
import { PermissionReviewer } from "@/permission/reviewer"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const alias = ModelV2.ID.make("gpt-5.6-luna-oauth")
let resolved = ProviderTest.model({
  id: alias,
  api: { id: "gpt-5.6-luna", url: "https://example.com", npm: "@ai-sdk/openai" },
})
let language = new MockLanguageModelV3()
let languageCalls = 0
let modelResolution: Promise<typeof resolved> | undefined
let failModelLookup = false
let requireRuntimeMarker = false
let failAuth = false
const modelRequests: Array<readonly [string, string]> = []
const RuntimeMarker = Context.Reference<string>("@test/PermissionReviewerRuntimeMarker", {
  defaultValue: () => "missing",
})

const provider = ProviderTest.fake({
  model: resolved,
  getModel: (providerID, modelID) => {
    modelRequests.push([providerID, modelID])
    if (failModelLookup) return Effect.die(new Error("raw model lookup failure secret"))
    return Effect.gen(function* () {
      if (requireRuntimeMarker && (yield* RuntimeMarker) !== "present") {
        return yield* Effect.die(new Error("instance FiberRef context was lost"))
      }
      return modelResolution ? yield* Effect.promise(() => modelResolution!) : resolved
    })
  },
  getLanguage: () => {
    languageCalls++
    return Effect.succeed(language)
  },
})
const auth = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () =>
      failAuth
        ? Effect.fail(new Auth.AuthError({ message: "raw auth failure secret" }))
        : Effect.succeed({ type: "oauth", refresh: "test", access: "test", expires: Date.now() + 60_000 } as const),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)
const env = AppNodeBuilder.build(LayerNode.group([PermissionReviewer.node]), [
  [Provider.node, provider.layer],
  [Auth.node, auth],
])
const it = testEffect(env)

const config = { mode: "enforce", model: `openai/${alias}` } as const
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function output(text: string, chunks = [text]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "review" },
        ...chunks.map((delta) => ({ type: "text-delta" as const, id: "review", delta })),
        { type: "text-end" as const, id: "review" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
    }),
  }
}

function reset(text = '{"decision":"allow"}') {
  resolved = ProviderTest.model({
    id: alias,
    api: { id: "gpt-5.6-luna", url: "https://example.com", npm: "@ai-sdk/openai" },
  })
  language = new MockLanguageModelV3({
    doStream: (call) => {
      if (call.maxOutputTokens !== undefined) throw new Error("Unsupported parameter: max_output_tokens")
      return Promise.resolve(output(text))
    },
  })
  languageCalls = 0
  modelResolution = undefined
  failModelLookup = false
  requireRuntimeMarker = false
  failAuth = false
  modelRequests.length = 0
}

function promptText(index: number) {
  const prompt = language.doStreamCalls[index]?.prompt[0]
  if (!prompt) return ""
  if (typeof prompt.content === "string") return prompt.content
  return prompt.content.find((part) => part.type === "text")?.text ?? ""
}

it.effect("accepts the configured Luna alias and makes one isolated tool-less OAuth request", () =>
  Effect.gen(function* () {
    reset()
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ decision: "ask" })

    expect(languageCalls).toBe(1)
    expect(modelRequests).toEqual([["openai", "gpt-5.6-luna-oauth"]])
    expect(language.doGenerateCalls).toHaveLength(0)
    expect(language.doStreamCalls).toHaveLength(1)
    const call = language.doStreamCalls[0]!
    expect(call.tools).toBeUndefined()
    expect(call.toolChoice).toBeUndefined()
    expect(call.maxOutputTokens).toBeUndefined()
    expect(call.temperature).toBe(0)
    expect(call.abortSignal).toBeInstanceOf(AbortSignal)
    expect(call.prompt).toHaveLength(1)
    expect(call.prompt[0]?.role).toBe("user")
    expect(call.responseFormat).toMatchObject({ type: "json" })
    expect(call.providerOptions?.openai).toMatchObject({ reasoningEffort: "low", store: false })
    expect(call.providerOptions?.openai?.instructions).toContain("isolated permission reviewer")
  }),
)

it.effect("shapes a valid streaming structured OpenAI Responses request at the adapter boundary", () =>
  Effect.promise(async () => {
    let requestBody: Record<string, unknown> | undefined
    const openai = createOpenAI({
      apiKey: "test",
      baseURL: "https://openai.invalid/v1",
      fetch: Object.assign(
        async (_input: URL | RequestInfo, init?: RequestInit) => {
          requestBody = JSON.parse(String(init?.body))
          const events = [
            {
              type: "response.output_text.delta",
              item_id: "review",
              delta: '{"decision":"ask"}',
            },
            {
              type: "response.completed",
              response: {
                incomplete_details: null,
                usage: {
                  input_tokens: 1,
                  input_tokens_details: null,
                  output_tokens: 1,
                  output_tokens_details: null,
                },
                reasoning: null,
                service_tier: null,
              },
            },
          ]
          const data = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
          return new Response(data, { headers: { "content-type": "text/event-stream" } })
        },
        { preconnect: fetch.preconnect },
      ),
    })
    const decision = Schema.Struct({ decision: Schema.Literals(["allow", "ask", "deny"]) })
    const schema = Object.assign(Schema.toStandardSchemaV1(decision), Schema.toStandardJSONSchemaV1(decision))
    const result = streamText({
      model: openai.responses("gpt-5.6-luna"),
      messages: [{ role: "user", content: "fixed untrusted data wrapper" }],
      output: Output.object({ schema }),
      maxRetries: 0,
      providerOptions: {
        openai: { instructions: "fixed reviewer instructions", reasoningEffort: "low", store: false },
      },
    })
    let text = ""
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") text += chunk.text
    }

    expect(text).toBe('{"decision":"ask"}')
    expect(requestBody).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
      instructions: "fixed reviewer instructions",
      reasoning: { effort: "low" },
    })
    expect(requestBody).not.toHaveProperty("max_output_tokens")
    expect(requestBody).not.toHaveProperty("tools")
    expect(requestBody).toHaveProperty("text.format.type", "json_schema")
  }),
)

it.effect("does not auto-allow a shell operation whose redacted semantics are not fully classified", () =>
  Effect.gen(function* () {
    reset()
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({
        config,
        permission: "bash",
        origin: "tool",
        arguments: { command: "python /home/alice/private-script.py" },
      }),
    ).toEqual({ decision: "ask" })
    expect(language.doStreamCalls).toHaveLength(1)
    expect(promptText(0)).not.toContain("alice")
    expect(promptText(0)).not.toContain("private-script")
  }),
)

it.effect("preserves Luna's proposed allow for audit-only observation", () =>
  Effect.gen(function* () {
    reset()
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({
        config: { ...config, mode: "audit-only" },
        permission: "bash",
        origin: "tool",
        arguments: { command: "git status" },
      }),
    ).toEqual({ decision: "allow" })
  }),
)

it.effect("rejects aliases that do not resolve to the exact Luna model", () =>
  Effect.gen(function* () {
    reset()
    resolved = ProviderTest.model({
      id: alias,
      api: { id: "gpt-5.6-sol", url: "https://example.com", npm: "@ai-sdk/openai" },
    })
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ failure: "model_identity" })
    expect(languageCalls).toBe(0)
  }),
)

it.effect("reports model lookup failures without exposing provider details", () =>
  Effect.gen(function* () {
    reset()
    failModelLookup = true
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ failure: "model_lookup" })
    expect(languageCalls).toBe(0)
  }),
)

it.effect("preserves instance references in supervised reviewer work", () =>
  Effect.gen(function* () {
    reset()
    requireRuntimeMarker = true
    const reviewer = yield* PermissionReviewer.Service
    const result = yield* reviewer
      .review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } })
      .pipe(Effect.provideService(RuntimeMarker, "present"))
    expect(result).toEqual({ decision: "ask" })
    expect(languageCalls).toBe(1)
  }),
)

it.effect("strictly rejects malformed decisions and extra keys", () =>
  Effect.gen(function* () {
    const reviewer = yield* PermissionReviewer.Service
    for (const text of [
      "",
      '{"decision":"approve"}',
      '{"decision":"allow","rationale":"safe"}',
      '{"decision":"deny","decision":"allow"}',
      '```json {"decision":"allow"} ```',
    ]) {
      reset(text)
      const result = yield* reviewer.review({
        config,
        permission: "bash",
        origin: "tool",
        arguments: { command: "git status" },
      })
      expect("failure" in result).toBe(true)
    }

    reset(`${" ".repeat(257)}{"decision":"allow"}`)
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ failure: "size" })
  }),
)

it.effect("rejects unsupported reasoning output instead of ignoring it", () =>
  Effect.gen(function* () {
    reset()
    language = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks: [
              { type: "reasoning-start" as const, id: "reasoning" },
              { type: "reasoning-delta" as const, id: "reasoning", delta: "hidden" },
              { type: "reasoning-end" as const, id: "reasoning" },
              { type: "text-start" as const, id: "review" },
              { type: "text-delta" as const, id: "review", delta: '{"decision":"allow"}' },
              { type: "text-end" as const, id: "review" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
            ],
          }),
        }),
    })
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ failure: "malformed" })
  }),
)

it.effect("aborts and rejects as soon as streamed raw output exceeds 256 bytes", () =>
  Effect.gen(function* () {
    reset()
    let signal: AbortSignal | undefined
    language = new MockLanguageModelV3({
      doStream: (call) => {
        signal = call.abortSignal
        return Promise.resolve(output("", ["x".repeat(200), "y".repeat(57), '{"decision":"allow"}']))
      },
    })
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ failure: "size" })
    expect(signal?.aborted).toBe(true)
  }),
)

it.effect("rejects unclassifiable and oversized input before generation", () =>
  Effect.gen(function* () {
    reset()
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "edit", origin: "tool", arguments: { filePath: "/x" } }),
    ).toEqual({
      failure: "input",
    })
    expect(
      yield* reviewer.review({
        config,
        permission: "bash",
        origin: "tool",
        arguments: { command: "x".repeat(256 * 1024 + 1) },
      }),
    ).toEqual({ failure: "input" })
    expect(language.doStreamCalls).toHaveLength(0)
  }),
)

it.effect("maps provider failures to a fixed category without exposing the error", () =>
  Effect.gen(function* () {
    reset()
    language = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("raw provider body secret")
      },
    })
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ failure: "provider" })
    expect(language.doStreamCalls).toHaveLength(1)
  }),
)

it.effect("suppresses provider failures from console and stderr", () =>
  Effect.gen(function* () {
    reset()
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      language = new MockLanguageModelV3({
        doStream: async () => {
          throw new Error("raw provider body secret")
        },
      })
      const reviewer = yield* PermissionReviewer.Service
      expect(
        yield* reviewer.review({
          config,
          permission: "bash",
          origin: "tool",
          arguments: { command: "git status" },
        }),
      ).toEqual({ failure: "provider" })
      expect(consoleError).not.toHaveBeenCalled()
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
      stderr.mockRestore()
    }
  }),
)

it.effect("maps auth failures to a fixed category before generation", () =>
  Effect.gen(function* () {
    reset()
    failAuth = true
    const reviewer = yield* PermissionReviewer.Service
    expect(
      yield* reviewer.review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } }),
    ).toEqual({ failure: "auth" })
    expect(language.doStreamCalls).toHaveLength(0)
  }),
)

it.effect("aborts generation at the single 30-second deadline", () =>
  Effect.gen(function* () {
    reset()
    let signal: AbortSignal | undefined
    language = new MockLanguageModelV3({
      doStream: (call) => {
        signal = call.abortSignal
        return new Promise<never>((_, reject) =>
          call.abortSignal?.addEventListener("abort", () => reject(new Error("aborted"))),
        )
      },
    })
    const reviewer = yield* PermissionReviewer.Service
    const fiber = yield* reviewer
      .review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } })
      .pipe(Effect.forkScoped)
    while (!signal) yield* Effect.yieldNow
    yield* TestClock.adjust("30 seconds")
    expect(yield* Fiber.join(fiber)).toEqual({ failure: "timeout" })
    expect(signal.aborted).toBe(true)
  }),
)

it.effect("starts the single 30-second deadline before model resolution", () =>
  Effect.gen(function* () {
    reset()
    let resolveModel!: (model: typeof resolved) => void
    modelResolution = new Promise((resolve) => {
      resolveModel = resolve
    })
    const reviewer = yield* PermissionReviewer.Service
    const run = yield* reviewer.prepare({
      config,
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status" },
    })
    const fiber = yield* run.result.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* TestClock.adjust("30 seconds")
    expect(yield* Fiber.join(fiber)).toEqual({ failure: "timeout" })
    expect(languageCalls).toBe(0)
    expect(run.isSettled()).toBe(false)
    resolveModel(resolved)
    yield* run.settled
    expect(languageCalls).toBe(0)
  }),
)

it.effect("retains settlement separately when model resolution ignores cancellation", () =>
  Effect.gen(function* () {
    reset()
    let resolveModel!: (model: typeof resolved) => void
    modelResolution = new Promise((resolve) => {
      resolveModel = resolve
    })
    const reviewer = yield* PermissionReviewer.Service
    const run = yield* reviewer.prepare({
      config,
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status" },
    })
    const result = yield* run.result.pipe(Effect.forkScoped)
    const settled = yield* run.settled.pipe(Effect.forkScoped)
    yield* TestClock.adjust("30 seconds")
    expect(yield* Fiber.join(result)).toEqual({ failure: "timeout" })
    expect(run.isSettled()).toBe(false)
    expect(settled.pollUnsafe()).toBeUndefined()
    resolveModel(resolved)
    yield* Fiber.join(settled)
    expect(run.isSettled()).toBe(true)
  }),
)

it.effect("does not strand admission when interrupted during native model resolution", () =>
  Effect.gen(function* () {
    reset()
    let resolveModel!: (model: typeof resolved) => void
    modelResolution = new Promise((resolve) => {
      resolveModel = resolve
    })
    const reviewer = yield* PermissionReviewer.Service
    const run = yield* reviewer.prepare({
      config,
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status" },
    })
    const result = yield* run.result.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(result)
    expect(run.isSettled()).toBe(false)

    resolveModel(resolved)
    yield* run.settled
    expect(run.isSettled()).toBe(true)
    expect(languageCalls).toBe(0)
  }),
)

it.effect("retains settlement separately when generation ignores abort", () =>
  Effect.gen(function* () {
    reset()
    let signal: AbortSignal | undefined
    let resolveStream!: (value: ReturnType<typeof output>) => void
    language = new MockLanguageModelV3({
      doStream: (call) => {
        signal = call.abortSignal
        return new Promise((resolve) => {
          resolveStream = resolve
        })
      },
    })
    const reviewer = yield* PermissionReviewer.Service
    const run = yield* reviewer.prepare({
      config,
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status" },
    })
    const result = yield* run.result.pipe(Effect.forkScoped)
    const settled = yield* run.settled.pipe(Effect.forkScoped)
    while (!signal) yield* Effect.yieldNow
    yield* TestClock.adjust("30 seconds")
    expect(yield* Fiber.join(result)).toEqual({ failure: "timeout" })
    expect(signal.aborted).toBe(true)
    expect(run.isSettled()).toBe(false)
    expect(settled.pollUnsafe()).toBeUndefined()
    resolveStream(output('{"decision":"allow"}'))
    yield* Fiber.join(settled)
    expect(run.isSettled()).toBe(true)
  }),
)

it.effect("preserves interruption and cooperatively aborts generation", () =>
  Effect.gen(function* () {
    reset()
    let signal: AbortSignal | undefined
    language = new MockLanguageModelV3({
      doStream: (call) => {
        signal = call.abortSignal
        return new Promise<never>((_, reject) =>
          call.abortSignal?.addEventListener("abort", () => reject(new Error("aborted"))),
        )
      },
    })
    const reviewer = yield* PermissionReviewer.Service
    const fiber = yield* reviewer
      .review({ config, permission: "bash", origin: "tool", arguments: { command: "git status" } })
      .pipe(Effect.forkScoped)
    while (!signal) yield* Effect.yieldNow
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(signal.aborted).toBe(true)
  }),
)

it.effect("keeps ignored-abort work globally bounded until actual native settlement", () =>
  Effect.gen(function* () {
    reset()
    const resolvers: Array<(value: ReturnType<typeof output>) => void> = []
    language = new MockLanguageModelV3({
      doStream: () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    })
    const reviewer = yield* PermissionReviewer.Service
    const runs: Array<PermissionReviewer.Run> = []
    for (let index = 0; index < PermissionReviewer.CAPACITY; index++) {
      runs.push(
        yield* reviewer.prepare({
          config,
          permission: "bash",
          origin: "tool",
          arguments: { command: "git status" },
        }),
      )
    }
    while (resolvers.length < PermissionReviewer.CAPACITY) yield* Effect.yieldNow
    for (const run of runs) run.abort()

    const rejected = yield* reviewer.prepare({
      config,
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status" },
    })
    expect(rejected.admitted).toBe(false)
    expect(yield* rejected.result).toEqual({ failure: "capacity" })

    for (const resolve of resolvers) resolve(output('{"decision":"allow"}'))
    yield* Effect.all(runs.map((run) => run.settled))
    expect(runs.every((run) => run.isSettled())).toBe(true)

    const admitted = yield* reviewer.prepare({
      config,
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status" },
    })
    expect(admitted.admitted).toBe(true)
    while (resolvers.length < PermissionReviewer.CAPACITY + 1) yield* Effect.yieldNow
    resolvers.at(-1)!(output('{"decision":"allow"}'))
    yield* admitted.result
  }),
)

it.effect("aborts layer-owned work without falsely marking native settlement", () =>
  Effect.gen(function* () {
    reset()
    let signal: AbortSignal | undefined
    let resolveStream!: (value: ReturnType<typeof output>) => void
    language = new MockLanguageModelV3({
      doStream: (call) => {
        signal = call.abortSignal
        return new Promise((resolve) => {
          resolveStream = resolve
        })
      },
    })
    const scope = yield* Scope.make()
    const isolated = Layer.fresh(PermissionReviewer.layer).pipe(Layer.provide(Layer.merge(provider.layer, auth)))
    const context = yield* Layer.buildWithScope(isolated, scope)
    const reviewer = Context.get(context, PermissionReviewer.Service)
    const run = yield* reviewer.prepare({
      config,
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status" },
    })
    while (!signal) yield* Effect.yieldNow

    yield* Scope.close(scope, Exit.void)
    expect(signal.aborted).toBe(true)
    expect(run.isSettled()).toBe(false)

    resolveStream(output('{"decision":"allow"}'))
    yield* run.settled
    expect(run.isSettled()).toBe(true)
  }),
)
