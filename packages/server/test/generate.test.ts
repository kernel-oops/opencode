import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Generate } from "@opencode/core/generate"
import { Model } from "@opencode/core/model"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Predicate } from "effect"
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
        video: {
          start: () => Effect.die("unused"),
          status: () => Effect.die("unused"),
          result: () => Effect.die("unused"),
          cancel: () => Effect.die("unused"),
        },
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

// Fork note: the plugin-readiness wait tests (B11 restack) were removed in B21: upstream ce7b4252d8 stopped
// waiting for plugins in the generate handler, and clients now wait for what they need themselves.
