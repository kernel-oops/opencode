import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Generate } from "@opencode/core/generate"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { Location } from "@opencode/core/location"
import { LocationWatcher } from "@opencode/core/filesystem/location-watcher"
import { LanguageModel, LLMClient, LLMResponse, Usage } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Global } from "@opencode/util/global"
import { Model } from "@opencode/core/model"
import { RequestExecutor } from "@opencode/ai/route"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Deferred, Effect, Fiber, Layer, Predicate } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { OpenCode } from "@opencode/client"

const generate = makeLocationNode({
  service: Generate.Service,
  layer: Layer.effect(
    Generate.Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      return Generate.Service.of({
        result: (input) =>
          config.entries().pipe(
            Effect.map((entries) => ({
              text: JSON.stringify({ model: Config.latest(entries, "model") }),
              model: Model.Ref.parse("base/default"),
              usage: { inputTokens: 0, outputTokens: 2 },
              ...(input.responseSchema ? { responseSchemaName: input.responseSchema.name } : {}),
            })),
          ),
        text: () =>
          config.entries().pipe(
            Effect.map((entries) =>
              JSON.stringify({
                model: Config.latest(entries, "model"),
              }),
            ),
          ),
        image: () => Effect.die("unused"),
        decisions: () => Effect.die("unused"),
      })
    }),
  ),
  deps: [Config.node],
})

it.live("native schema input and acknowledgement round-trip through the generated HTTP client", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-schema-endpoint-")))
    yield* Effect.promise(() =>
      fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify({ model: "base/default" })),
    )
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: tmp.path },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Generate.node.replace(generate)] },
    )
    const client = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    const responseSchema = { name: "permission_http_v1", schema: { type: "object" } }
    const result = yield* Effect.promise(() => client.generate.text({ prompt: "Review", responseSchema }))
    expect(result.responseSchemaName).toBe(responseSchema.name)
    const plaintext = yield* Effect.promise(() => client.generate.text({ prompt: "Plain text" }))
    expect(Object.hasOwn(plaintext, "responseSchemaName")).toBe(false)
    const invalid = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/experimental/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Review", responseSchema: { ...responseSchema, name: "invalid.name" } }),
        }),
      ),
    )
    expect(invalid.status).toBe(400)
  }),
)

it.live("uses base configuration without depending on process.cwd()", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-generate-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    yield* Effect.promise(() => Promise.all([fs.mkdir(global), fs.mkdir(project)]))
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(path.join(global, "opencode.json"), JSON.stringify({ model: "base/default" })),
        fs.writeFile(path.join(project, "opencode.json"), JSON.stringify({ model: "project/default" })),
      ]),
    )
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: global },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      { overrides: [Generate.node.replace(generate)] },
    )

    expect(global).not.toBe(process.cwd())
    expect(yield* request(handler, new URL("http://opencode.local/api/experimental/generate/text"))).toEqual({
      model: { providerID: "base", model: "default" },
    })

    const legacy = new URL("http://opencode.local/api/experimental/generate/text")
    legacy.searchParams.set("location[directory]", project)
    expect(yield* request(handler, legacy)).toEqual({
      model: { providerID: "base", model: "default" },
    })

    const deprecatedPath = new URL("http://opencode.local/api/experimental/generate")
    expect(yield* request(handler, deprecatedPath)).toEqual({
      model: { providerID: "base", model: "default" },
    })
  }),
)

it.live("rejects unknown image and decision models and duplicate question names", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-generate-media-")))
    const handler = yield* ServerFetch.make({
      database: { path: ":memory:" },
      config: { directory: tmp.path },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const model = { providerID: "nowhere", id: "nothing" }
    const question = { type: "predicate", name: "refund", instructions: "Is this a refund request?" }
    const post = (path: string, body: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local/api/experimental/generate/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )
    for (const [path, body] of [
      ["image", { model, prompt: "a red square" }],
      ["decisions", { model, input: [{ type: "text", text: "I was charged twice." }], questions: [question] }],
    ] as const) {
      const response = yield* post(path, body)
      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ _tag: "ModelNotFoundError" })
    }
    const duplicate = yield* post("decisions", { model, input: [], questions: [question, question] })
    expect(duplicate.status).toBe(400)
  }),
)

function request(handler: (request: Request) => Promise<Response>, url: URL) {
  return Effect.promise(() =>
    handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      }),
    ).then(async (response) => {
      expect(response.status).toBe(200)
      const body: unknown = await response.json()
      if (!Predicate.isObject(body) || !Predicate.isObject(body.data) || typeof body.data.text !== "string")
        throw new Error("Expected a generate response")
      expect(body.data.model).toEqual({ providerID: "base", id: "default" })
      expect(body.data.usage).toEqual({ inputTokens: 0, outputTokens: 2 })
      const result: unknown = JSON.parse(body.data.text)
      return result
    }),
  )
}

// Synthetic registration isolates the readiness boundary, while the HTTP handler and Generate.layer are real.
// No production providers, credentials, environment, catalogue fetches or persistent stores are used.
for (const outcome of ["registered", "absent", "failed"] as const) {
  for (const explicit of [true, false]) {
    it.live(`generation waits for ${outcome} activation with ${explicit ? "explicit" : "default"} selection`, () =>
      Effect.gen(function* () {
        const fixture = yield* readinessFixture()
        const pending = yield* fixture.request(explicit).pipe(Effect.forkScoped)
        expect(yield* fixture.reachedGate(pending)).toBe(true)
        expect(pending.pollUnsafe()).toBeUndefined()
        expect(fixture.resolutions).toEqual([])
        expect(fixture.calls).toEqual([])
        yield* fixture.settle(outcome)
        expect(fixture.failures).toHaveLength(outcome === "failed" ? 1 : 0)
        const response = yield* Fiber.join(pending).pipe(Effect.timeout("2 seconds"))
        const body = yield* Effect.promise(() => response.json())
        expect(fixture.resolutions).toEqual([fixture.base])
        expect(fixture.early).toEqual([])
        if (outcome !== "registered") {
          expect(response.status).toBe(explicit ? 404 : 503)
          expect(body).toMatchObject({
            _tag: explicit ? "ModelNotFoundError" : "ServiceUnavailableError",
            message: explicit
              ? "Model not found: fixture/chat"
              : "No model specified and no supported model is available",
          })
          expect(fixture.calls).toEqual([])
          return
        }
        expect(response.status).toBe(200)
        expect(fixture.calls).toEqual([1])
        expect(body).toEqual({
          data: {
            text: "OK",
            model: { providerID: "fixture", id: "chat" },
            usage: {
              inputTokens: 0,
              outputTokens: 2,
              providerMetadata: { openai: { prompt_tokens: 0 } },
            },
          },
        })
      }),
    )
  }
}

it.live("aborting a pending readiness wait leaves later generation serviceable", () =>
  Effect.gen(function* () {
    const fixture = yield* readinessFixture()
    const aborted = yield* fixture.request(true).pipe(Effect.forkScoped)
    expect(yield* fixture.reachedGate(aborted)).toBe(true)
    yield* Fiber.interrupt(aborted)
    expect(fixture.resolutions).toEqual([])
    expect(fixture.calls).toEqual([])
    expect(yield* Deferred.isDone(fixture.release)).toBe(false)
    yield* fixture.settle("registered")
    const response = yield* fixture.request(true).pipe(Effect.timeout("2 seconds"))
    expect(response.status).toBe(200)
    expect(fixture.resolutions).toEqual([fixture.base])
    expect(fixture.early).toEqual([])
    expect(fixture.calls).toEqual([1])
  }),
)

const readinessFixture = Effect.fn(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-generate-readiness-")))
  const base = path.join(tmp.path, "base")
  const project = path.join(tmp.path, "project")
  yield* Effect.promise(() => Promise.all([fs.mkdir(base), fs.mkdir(project)]))
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const registered = new Set<string>()
  const failures: Plugin.Info[] = []
  const resolutions: string[] = []
  // Resolutions or LLM calls made before activation settled; the barrier must keep this empty.
  const early: string[] = []
  const calls: number[] = []
  let released = false
  const ref = Model.Ref.parse("fixture/chat")
  const selected = Model.Info.default(ref.providerID, ref.id)
  const resolver = Layer.effect(
    ModelResolver.Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      return ModelResolver.Service.of({
        resolveImage: () => Effect.die("unused"),
        resolveDecision: () => Effect.die("unused"),
        resolveModel: () => Effect.die("Unused by stateless generation"),
        nativeSteerSupport: () => Effect.die("Unused by stateless generation"),
        fallback: () => Effect.die("Unused by stateless generation"),
        resolve: () =>
          Effect.sync(() => {
            resolutions.push(location.directory)
            if (!released) early.push("resolve")
            return registered.has(location.directory)
              ? {
                  model: LanguageModel.make({ id: "chat", provider: "fixture", route: OpenAIChat.route }),
                  ref,
                  capabilities: selected.capabilities,
                  cost: selected.cost,
                  limit: selected.limit,
                }
              : undefined
          }),
      })
    }),
  )
  const client = Layer.mock(LLMClient.Service, {
    generate: () =>
      Effect.sync(() => {
        calls.push(1)
        if (!released) early.push("generate")
        const response = LLMResponse.fromEvents(TestLLM.text("OK", "readiness"))!
        return new LLMResponse({
          ...response,
          usage: new Usage({
            inputTokens: 0,
            outputTokens: 2,
            providerMetadata: { openai: { prompt_tokens: 0, apiKey: "forbidden", reasoning: "forbidden" } },
          }),
        })
      }),
  })
  const readiness = Layer.effect(
    Plugin.Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      return Plugin.Service.of({
        gui: () => Effect.undefined,
        awaitActivation:
          location.directory === base
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        activate: () => Effect.void,
        list: () => Effect.succeed(failures),
        close: () => Effect.void,
        hold: () => Effect.succeed(Effect.void),
      })
    }),
  )
  const handler = yield* ServerFetch.make(
    {
      database: { path: ":memory:" },
      config: { directory: base, project: false },
      fs: { filewatcher: false },
      models: { fetch: false },
    },
    {
      overrides: [
        Global.node.replace(
          Global.layerWith({
            home: tmp.path,
            config: base,
            data: path.join(tmp.path, "data"),
            cache: path.join(tmp.path, "cache"),
            state: path.join(tmp.path, "state"),
            tmp: path.join(tmp.path, "tmp"),
            bin: path.join(tmp.path, "bin"),
            log: path.join(tmp.path, "log"),
            repos: path.join(tmp.path, "repos"),
          }),
        ),
        Plugin.node.replace(makeLocationNode({ service: Plugin.Service, layer: readiness, deps: [Location.node] })),
        // The location watcher also awaits activation in a background fiber; omitting it means only the request can
        // reach the gate, so the fixture cannot mistake that wait for the handler's.
        LocationWatcher.node.replace(
          makeLocationNode({
            service: LocationWatcher.Service,
            layer: Layer.succeed(LocationWatcher.Service, {}),
            deps: [],
          }),
        ),
        Generate.node.replace(
          makeLocationNode({
            service: Generate.Service,
            layer: Generate.layer.pipe(Layer.provide(Layer.mergeAll(resolver, client, Layer.mock(Model.Service, { available: () => Effect.succeed([]) }), RequestExecutor.fetchLayer))),
            deps: [Location.node],
          }),
        ),
      ],
    },
  )
  return {
    base,
    entered,
    release,
    resolutions,
    calls,
    failures,
    early,
    // True when the request waits at the activation gate; false when it completes without waiting.
    reachedGate: <A, E>(request: Fiber.Fiber<A, E>) =>
      Effect.raceFirst(Deferred.await(entered).pipe(Effect.as(true)), Fiber.await(request).pipe(Effect.as(false))),
    settle: (outcome: "registered" | "absent" | "failed") =>
      Effect.sync(() => {
        released = true
        if (outcome === "registered") registered.add(base)
        if (outcome === "failed")
          failures.push({
            id: Plugin.ID.make("synthetic-registration"),
            source: { type: "sdk" },
            features: {},
            state: { status: "failed", error: "Synthetic activation failure" },
          })
      }).pipe(Effect.andThen(Deferred.succeed(release, undefined))),
    request: (explicit: boolean) =>
      Effect.promise((signal) => {
        const url = new URL("http://opencode.local/api/experimental/generate")
        url.searchParams.set("location[directory]", project)
        return handler(
          new Request(url, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json", "x-opencode-directory": project },
            body: JSON.stringify({ prompt: "hello", ...(explicit ? { model: ref } : {}) }),
          }),
        )
      }),
  }
})
