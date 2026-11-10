import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// Offline fixture only: the provider endpoint is never contacted because no prompt is submitted.
const config = (allowance: boolean) => ({
  // The resolver gates native steering on a GPT-6 identity as well as the Responses route and the allowance.
  model: "fixture/gpt-6",
  providers: {
    fixture: {
      package: "@opencode/ai/providers/openai",
      settings: {
        baseURL: "https://fixture.invalid/v1",
        apiKey: "fixture-secret-key",
        transport: "http",
        ...(allowance ? { nativeSteer: "response.steer" } : {}),
      },
      models: { "gpt-6": {}, chat: {} },
    },
  },
})

const setup = (allowance: boolean) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-native-test-")))
    yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "opencode.json"), JSON.stringify(config(allowance))))
    const server = yield* startServer(tmp.path)
    const call = (method: string, route: string, body?: unknown, headers: Record<string, string> = server.headers) =>
      Effect.promise(async () => {
        const response = await fetch(new URL(route, server.base), {
          method,
          headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const text = await response.text()
        return { status: response.status, text, body: text ? (JSON.parse(text) as Record<string, any>) : undefined }
      })
    const created = yield* call("POST", "/api/session", { title: "Native test", location: { directory: tmp.path } })
    expect(created.status).toBe(200)
    return { call, server, sessionID: created.body!.data.id as string }
  })

it.live("reads and requests the exact-session native test lane through the authenticated API", () =>
  Effect.gen(function* () {
    const { call, sessionID } = yield* setup(true)
    const route = `/api/experimental/session/${sessionID}/native-test`

    expect((yield* call("GET", route, undefined, {})).status).toBe(401)
    const missing = yield* call("GET", "/api/experimental/session/ses_missing_native_test/native-test")
    expect(missing.status).toBe(404)

    const initial = yield* call("GET", route)
    expect(initial.status).toBe(200)
    expect(initial.body!.data).toMatchObject({
      sessionID,
      requested: { nativeSteer: false, debug: false },
      effective: { nativeSteer: false, debug: false },
      pending: false,
      supported: true,
      reason: "not-requested",
      unresolvedFence: false,
      diagnostics: { records: [], dropped: 0, coalesced: 0, progress: 0 },
    })
    expect(typeof initial.body!.data.serverRun).toBe("string")
    // Status never exposes provider settings, credentials or endpoints.
    for (const secret of ["fixture-secret-key", "fixture.invalid", "baseURL", "apiKey"]) expect(initial.text).not.toContain(secret)

    expect((yield* call("PUT", route, { nativeSteer: true, debug: false })).status).toBe(400)
    expect((yield* call("PUT", route, { nativeSteer: "response.steer" })).status).toBe(400)
    expect((yield* call("PUT", route, { nativeSteer: "response.steer", debug: "verbose" })).status).toBe(400)
    const extra = yield* call("PUT", route, { nativeSteer: false, debug: false, transport: "websocket" })
    expect(extra.status).toBe(400)
    expect((yield* call("GET", route)).body!.data.requested).toEqual({ nativeSteer: false, debug: false })

    const enabled = yield* call("PUT", route, { nativeSteer: "response.steer", debug: "metadata" })
    expect(enabled.status).toBe(200)
    expect(enabled.body!.data).toMatchObject({
      requested: { nativeSteer: "response.steer", debug: "metadata" },
      effective: { nativeSteer: false, debug: false },
      pending: false,
      reason: "allowed",
    })

    // Not inherited: a child session stays off, and a second lane is refused rather than evicting the first.
    const child = yield* call("POST", "/api/session", { parentID: sessionID, title: "Child" })
    expect(child.status).toBe(200)
    const childRoute = `/api/experimental/session/${child.body!.data.id}/native-test`
    expect((yield* call("GET", childRoute)).body!.data.requested).toEqual({ nativeSteer: false, debug: false })
    const second = yield* call("PUT", childRoute, { nativeSteer: "response.steer", debug: false })
    expect(second.status).toBe(409)

    const disabled = yield* call("PUT", route, { nativeSteer: false, debug: false })
    expect(disabled.body!.data.requested).toEqual({ nativeSteer: false, debug: false })
    expect((yield* call("PUT", childRoute, { nativeSteer: "response.steer", debug: false })).status).toBe(200)
  }).pipe(Effect.scoped),
)

it.live("refuses native steering when the operator allowance is absent", () =>
  Effect.gen(function* () {
    const { call, sessionID } = yield* setup(false)
    const route = `/api/experimental/session/${sessionID}/native-test`
    const status = yield* call("GET", route)
    expect(status.body!.data).toMatchObject({ supported: false, reason: "not-requested" })
    const refused = yield* call("PUT", route, { nativeSteer: "response.steer", debug: false })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ reason: "allowance-missing" })
    // Metadata debug alone needs no allowance and activates nothing.
    const debug = yield* call("PUT", route, { nativeSteer: false, debug: "metadata" })
    expect(debug.status).toBe(200)
    expect(debug.body!.data).toMatchObject({ requested: { nativeSteer: false, debug: "metadata" }, reason: "not-requested" })
  }).pipe(Effect.scoped),
)

it.live("refuses a known non-Responses route offline without reserving the lane, on default and explicit selections", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-native-test-protocol-")))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          model: "chatfix/chat",
          providers: {
            chatfix: {
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL: "https://fixture.invalid/v1", apiKey: "fixture-secret-key", transport: "http", nativeSteer: "response.steer" },
              models: { chat: {} },
            },
            fixture: config(true).providers.fixture,
          },
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const call = (method: string, route: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await fetch(new URL(route, server.base), {
          method,
          headers: { ...server.headers, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const text = await response.text()
        return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : undefined }
      })
    const chat = (yield* call("POST", "/api/session", { title: "Chat", location: { directory: tmp.path } })).body!.data.id as string
    const responses = (yield* call("POST", "/api/session", { title: "Responses", location: { directory: tmp.path } })).body!.data.id as string
    expect((yield* call("POST", `/api/session/${responses}/model`, { model: { providerID: "fixture", id: "gpt-6" } })).status).toBe(204)
    const route = (id: string) => `/api/experimental/session/${id}/native-test`

    // Default selection resolves to Chat Completions: not supported, refused, nothing reserved.
    expect((yield* call("GET", route(chat))).body!.data).toMatchObject({ supported: false, reason: "not-requested" })
    const refused = yield* call("PUT", route(chat), { nativeSteer: "response.steer", debug: false })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ reason: "protocol-unsupported" })
    expect((yield* call("GET", route(chat))).body!.data.requested).toEqual({ nativeSteer: false, debug: false })

    // Explicit OpenAI Responses selection in the same project is supported and can take the free lane.
    expect((yield* call("GET", route(responses))).body!.data).toMatchObject({ supported: true })
    expect((yield* call("PUT", route(responses), { nativeSteer: "response.steer", debug: false })).status).toBe(200)

    // Switching the explicit selection to the Chat route makes the status truthful again.
    expect((yield* call("POST", `/api/session/${chat}/model`, { model: { providerID: "fixture", id: "gpt-6" } })).status).toBe(204)
    expect((yield* call("GET", route(chat))).body!.data.supported).toBe(true)
    expect((yield* call("POST", `/api/session/${responses}/model`, { model: { providerID: "chatfix", id: "chat" } })).status).toBe(204)
    expect((yield* call("GET", route(responses))).body!.data).toMatchObject({ supported: false, reason: "protocol-unsupported" })

    // A Responses route without a GPT-6 identity is refused the same way.
    expect((yield* call("POST", `/api/session/${chat}/model`, { model: { providerID: "fixture", id: "chat" } })).status).toBe(204)
    expect((yield* call("GET", route(chat))).body!.data).toMatchObject({ supported: false, reason: "not-requested" })
    const unsupported = yield* call("PUT", route(chat), { nativeSteer: "response.steer", debug: false })
    expect(unsupported.status).toBe(400)
    expect(unsupported.body).toMatchObject({ reason: "protocol-unsupported" })
  }).pipe(Effect.scoped),
)
