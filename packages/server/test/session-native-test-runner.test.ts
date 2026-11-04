// Offline full-runner fixture: in-process HTTP handler, fake HTTP client and fake WebSocket connector.
// No provider, credential or network access; no model request leaves the process.
import { expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Queue, Stream } from "effect"
import { HttpClient, HttpClientResponse, HttpEffect, HttpRouter, HttpServer } from "effect/http"
import type { AIError } from "@opencode/ai/effect"
import type { WebSocketConnector } from "@opencode/ai/route"
import { Session } from "@opencode/core/session"
import { SessionNativeTest } from "@opencode/core/session/native-test"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionTitle } from "@opencode/core/session/title"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { createEmbeddedRoutes } from "../src/routes"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"

it.live("real runner: A native while B stays HTTP; a pending disable keeps the leased successor; the next HTTP execution retires A's socket", () => Effect.gen(function* () {
  const directory = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("native-test-runner-")))
  const parentReady = yield* Deferred.make<void>()
  const adopted = yield* Deferred.make<void>()
  const registry = SessionNativeTest.make()
  const lane: SessionNativeTest.Interface = { ...registry, observe: (id, fact) => {
    registry.observe(id, fact)
    if (fact.kind === "parent-created") Deferred.doneUnsafe(parentReady, Exit.succeed(undefined))
    if (fact.kind === "adopt") Deferred.doneUnsafe(adopted, Exit.succeed(undefined))
  } }
  const wire: Array<Record<string, unknown>> = []
  const httpSessions: string[] = []
  const incoming = yield* Queue.unbounded<string | Uint8Array, AIError>()
  let opened = 0
  let closed = 0
  const emit = (...frames: unknown[]) => Effect.forEach(frames, (frame) => Queue.offer(incoming, JSON.stringify(frame)), { discard: true })
  const output = (id: string) => ({ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture answer", annotations: [] }] })
  const completed = (id: string) => [
    { type: "response.output_item.done", item: output(id) },
    { type: "response.completed", response: { id, output: [output(id)], usage: { input_tokens: 2, output_tokens: 1 } } },
  ]
  const connector: WebSocketConnector = { open: () => Effect.sync(() => {
    opened++
    return {
      messages: Stream.fromQueue(incoming),
      close: Effect.sync(() => { closed++ }),
      sendText: (message) => Effect.gen(function* () {
        const frame = JSON.parse(message) as Record<string, unknown>
        wire.push(frame)
        if (frame.type === "response.create") {
          yield* emit({ type: "response.created", response: { id: "resp_parent" } })
          return
        }
        expect(frame.type).toBe("response.steer")
        yield* emit(
          { type: "response.steer.accepted", sequence_number: 1, steer: { id: "steer_fixture", previous_response_id: "resp_parent" } },
          { type: "response.incomplete", response: { id: "resp_parent", output: [], incomplete_details: { reason: "steered" }, usage: { input_tokens: 2, output_tokens: 0 } } },
          { type: "response.created", response: { id: "resp_successor", previous_response_id: "resp_parent" } },
        )
      }),
    }
  }) }
  const http = HttpClient.make((request) => Effect.sync(() => {
    expect(request.url).toBe("https://fixture.invalid/v1/responses")
    httpSessions.push(request.headers["x-opencode-session-id"] ?? "missing-session")
    const events = [{ type: "response.created", response: { id: "resp_http" } }, ...completed("resp_http")]
    return HttpClientResponse.fromWeb(request, new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
  }))
  const context = yield* Layer.build(createEmbeddedRoutes({
    app: { version: "native-test-runner" }, database: { path: ":memory:" }, models: { fetch: false }, fs: { filewatcher: false },
    config: { content: JSON.stringify({ model: "fixture/chat", providers: { fixture: {
      package: "@opencode/ai/providers/openai", settings: { baseURL: "https://fixture.invalid/v1", apiKey: "fixture-only", transport: "http", nativeSteer: "response.steer" }, models: { chat: { limit: { context: 100_000, output: 1_000 } } },
    } } }) },
  }, [
    Global.node.replace(tempGlobalLayer),
    httpClient.replace(Layer.succeed(HttpClient.HttpClient, http)),
    SessionNativeTest.node.replace(Layer.succeed(SessionNativeTest.Service, lane)),
    SessionModelTransport.node.replace(SessionModelTransport.makeLayer(connector, lane)),
    SessionTitle.node.replace(Layer.succeed(SessionTitle.Service, { generate: () => Effect.void })),
  ]).pipe(Layer.provide(HttpServer.layerServices)))
  const sessions = Context.get(context, Session.Service)
  const handler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
  const call = (method: string, route: string, body?: unknown) => Effect.promise(async () => {
    const response = await handler(new Request(`http://opencode.local${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  })
  const a = yield* call("POST", "/api/session", { title: "A", location: { directory: directory.path } })
  const b = yield* call("POST", "/api/session", { title: "B", location: { directory: directory.path } })
  expect(a.status).toBe(200)
  expect(b.status).toBe(200)
  const aid = Session.ID.make(a.body.data.id)
  const bid = Session.ID.make(b.body.data.id)
  const route = (id: string) => `/api/experimental/session/${id}/native-test`
  expect((yield* call("PUT", route(aid), { nativeSteer: "response.steer", debug: "metadata" })).status).toBe(200)
  expect((yield* call("POST", `/api/session/${aid}/prompt`, { text: "Original" })).status).toBe(200)
  yield* Deferred.await(parentReady)
  // Disable while the parent is still active, before any steer or successor lease exists.
  const pendingParent = yield* call("PUT", route(aid), { nativeSteer: false, debug: false })
  expect(pendingParent.body.data).toMatchObject({ pending: true, effective: { nativeSteer: "response.steer", debug: "metadata" }, execution: { active: true } })
  expect((yield* call("PUT", route(bid), { nativeSteer: "response.steer", debug: false })).status).toBe(409)
  expect((yield* call("POST", `/api/session/${bid}/prompt`, { text: "B stays HTTP" })).status).toBe(200)
  yield* sessions.wait(bid)
  expect(httpSessions).toEqual([bid])
  expect(opened).toBe(1)
  expect((yield* call("POST", `/api/session/${aid}/prompt`, { text: "Correction", resume: false })).status).toBe(200)
  yield* Deferred.await(adopted)
  const disabled = yield* call("PUT", route(aid), { nativeSteer: false, debug: false })
  expect(disabled.status).toBe(200)
  expect(disabled.body.data).toMatchObject({ requested: { nativeSteer: false, debug: false }, effective: { nativeSteer: "response.steer", debug: "metadata" }, pending: true, execution: { active: true, transport: "websocket" }, unresolvedFence: true })
  expect((yield* call("PUT", route(bid), { nativeSteer: "response.steer", debug: false })).status).toBe(409)
  expect(closed).toBe(0)
  yield* emit(...completed("resp_successor"))
  yield* sessions.wait(aid)
  expect(wire.map((frame) => frame.type)).toEqual(["response.create", "response.steer"])
  expect((yield* call("GET", route(aid))).body.data.unresolvedFence).toBe(false)
  expect((yield* call("POST", `/api/session/${aid}/prompt`, { text: "Next execution is HTTP" })).status).toBe(200)
  yield* sessions.wait(aid)
  expect(httpSessions).toEqual([bid, aid])
  expect(opened).toBe(1)
  // The opted-out execution's start retired the idle native socket; nothing was resent on it.
  expect(closed).toBe(1)
  expect(wire.map((frame) => frame.type)).toEqual(["response.create", "response.steer"])
}).pipe(Effect.scoped), { timeout: 15_000 })
