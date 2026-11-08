import { describe, expect } from "bun:test"
import { ToolDefinition } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Message } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/core/session"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionContextBudget } from "@opencode/core/session/context-budget"
import { DateTime, Effect, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const KINDS: ReadonlyArray<SessionRequestKind> = ["primary", "compaction", "title", "generate"]

const session = Session.Info.make({
  id: Session.ID.make("ses_hook_kind"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  steer: () => Effect.succeed(false),
  hasPendingInput: () => false,
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  retire: () => Effect.void,
  closeAll: Effect.void,
})

describe("SessionModelRequest HTTP hooks", () => {
  for (const kind of KINDS)
    it.effect(`unchanged long legacy cache identity retains upstream behaviour (${kind})`, () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("session", "model.request", () => Effect.void)
        const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
        const long = Session.Info.make({ ...session, id: Session.ID.make(`ses_${"legacy_".repeat(10)}`) })
        const prepared = yield* requests[kind]({ session: long, agent: Agent.ID.make("build"), model, system: [], messages: [] })
        expect(prepared.request.promptCacheKey).toBe(long.id)
      }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
    )
  for (const kind of KINDS)
    for (const cacheKey of [undefined, "shared-root", "😀".repeat(64)])
      it.effect(`model.request cacheKey reaches ${kind} (${cacheKey === undefined ? "disabled" : cacheKey.length})`, () =>
        Effect.gen(function* () {
          const hooks = yield* PluginHooks.Service
          yield* hooks.register("session", "model.request", (event) => Effect.sync(() => {
            expect(event.cacheKey).toBe(session.id)
            event.cacheKey = cacheKey
          }))
          const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
          const prepared = yield* requests[kind]({ session, agent: Agent.ID.make("build"), model, system: [], messages: [] })
          expect(prepared.request.promptCacheKey).toBe(cacheKey)
        }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
      )

  for (const cacheKey of ["", "x".repeat(65), 42])
    it.effect(`rejects invalid cacheKey (${String(cacheKey).length})`, () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("session", "model.request", (event) => Effect.sync(() => { event.cacheKey = cacheKey as string }))
        const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
        const result = yield* requests.primary({ session, agent: Agent.ID.make("build"), model, system: [], messages: [] }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
    )

  for (const [channel, httpHook] of [["http", false], ["http", true], ["websocket", false]] as const)
    it.effect(`late enable enforces current ${channel} policy (HTTP hook=${httpHook})`, () => Effect.gen(function* () {
      const sessions = yield* Session.Service
      const hooks = yield* PluginHooks.Service
      const stored = yield* sessions.create({ location: session.location })
      if (httpHook) yield* hooks.register("session", "http.request", () => Effect.void)
      const wire = JSON.stringify({ max_tokens: 32_000, messages: [{ content: "x".repeat(1_600_000) }] })
      let dispatched = false
      const websocket = SessionModelTransport.Service.of({ ...transport, bind: (_id, interceptor) => ({ execute: () => Effect.gen(function* () {
        yield* interceptor!.send!(wire)
        dispatched = true
        return { frames: Stream.empty, complete: Effect.void }
      }) }) })
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer), Effect.provideService(SessionModelTransport.Service, websocket))
      const prepared = yield* requests.primary({ session: stored, agent: Agent.ID.make("build"), model: { ...model, limit: { context: 1_000_000, output: 32_000 }, transport: channel }, system: [], messages: [], webSocket: "session" })
      yield* sessions.setContextBudget({ sessionID: stored.id, contextBudget: { target: 400_000, maximum: 480_000 } })
      const error = yield* (channel === "http"
        ? prepared.options.http!(HttpClientRequest.post("https://example.test/request").pipe(HttpClientRequest.bodyText(wire)), (request) => {
          dispatched = true
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))
        }).pipe(Effect.asVoid)
        : prepared.options.webSocket!.execute({} as never).pipe(Effect.asVoid)).pipe(Effect.flip)
      expect(SessionContextBudget.isBlocked(error)).toBe(true)
      expect(dispatched).toBe(false)
    }))

  it.effect("late enable cannot invent provenance for already-prepared encrypted reasoning", () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const stored = yield* sessions.create({ location: session.location })
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const prepared = yield* requests.primary({
      session: stored, agent: Agent.ID.make("build"), model, system: [],
      messages: [Message.make({ id: "msg_old", role: "assistant", content: [{ type: "reasoning", text: "Visible summary", providerMetadata: { test: { itemId: "rs_old", reasoningEncryptedContent: "unbound" } } }] })],
    })
    yield* sessions.setContextBudget({ sessionID: stored.id, contextBudget: { target: 400_000, maximum: 480_000 } })
    const error = yield* prepared.options.http!(HttpClientRequest.post("https://example.test/request").pipe(HttpClientRequest.bodyText(JSON.stringify({ max_tokens: 32_000, input: [{ type: "reasoning", id: "rs_old", summary: [], encrypted_content: "unbound" }] }))), () => Effect.die("must not dispatch")).pipe(Effect.flip)
    expect(SessionContextBudget.isBlocked(error)).toBe(true)
    expect(error.message).toContain("matching completed source usage")
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport)))

  it.effect("an unchanged unbudgeted no-hook request keeps its original HTTP body path", () => Effect.gen(function* () {
    const sessions = yield* Session.Service
    const stored = yield* sessions.create({ location: session.location })
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    const prepared = yield* requests.primary({ session: stored, agent: Agent.ID.make("build"), model, system: [], messages: [] })
    const original = HttpClientRequest.post("https://example.test/request").pipe(HttpClientRequest.bodyUint8Array(new Uint8Array([255])))
    yield* prepared.options.http!(original, (request) => {
      expect(request).toBe(original)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))
    })
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport)))

  for (const channel of ["http", "websocket"] as const) {
    for (const expanded of [false, true])
      it.effect(`budget checks final ${channel} hook payload (expanded=${expanded})`, () =>
        Effect.gen(function* () {
          const hooks = yield* PluginHooks.Service
          const frame = JSON.stringify({
            max_tokens: 32_000,
            messages: [{ role: "user", content: "x".repeat(expanded ? 600_000 : 10) }],
          })
          let dispatched = false
          yield* hooks.register("session", "http.request", (event) =>
            Effect.sync(() => {
              event.request = new Request(event.request, { body: frame })
            }),
          )
          yield* hooks.register("session", "experimental.ws.send", (event) =>
            Effect.sync(() => {
              event.frame = frame
            }),
          )
          const websocket = SessionModelTransport.Service.of({
            ...transport,
            bind: (_id, interceptor) => ({
              execute: () =>
                Effect.gen(function* () {
                  yield* interceptor!.send!("original")
                  dispatched = true
                  return { frames: Stream.empty, complete: Effect.void }
                }),
            }),
          })
          const requests = yield* SessionModelRequest.Service.pipe(
            Effect.provide(SessionModelRequest.layer),
            Effect.provideService(SessionModelTransport.Service, websocket),
          )
          const prepared = yield* requests.primary({
            session: Session.Info.make({ ...session, contextBudget: { target: 120_000, maximum: 160_000 } }),
            agent: Agent.ID.make("build"),
            model: { ...model, transport: channel },
            system: [],
            messages: [],
            webSocket: "session",
          })
          const result = yield* (
            channel === "http"
              ? prepared.options.http!(
                  HttpClientRequest.post("https://example.test/request").pipe(HttpClientRequest.bodyText("{}")),
                  (request) => {
                    dispatched = true
                    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))
                  },
                ).pipe(Effect.asVoid)
              : prepared.options.webSocket!.execute({} as never).pipe(Effect.asVoid)
          ).pipe(Effect.exit)
          expect(dispatched).toBe(!expanded)
          expect(result._tag).toBe(expanded ? "Failure" : "Success")
        }),
      )
  }

  it.effect("a late target crossing is a typed runner recovery, not a provider retry or dispatch", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const prepared = yield* requests.primary({
        session: Session.Info.make({ ...session, contextBudget: { target: 50_000, maximum: 160_000 } }),
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [],
        budgetBinding: "fixture",
      })
      const error = yield* prepared.options.http!(
        HttpClientRequest.post("https://example.test/request").pipe(
          HttpClientRequest.bodyText(
            JSON.stringify({ max_tokens: 32_000, messages: [{ content: "x".repeat(100_000) }] }),
          ),
        ),
        () => Effect.die("must not dispatch"),
      ).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionContextBudget.TargetReached)
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
  it.effect("tags every Session request kind on http.request and http.response", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: Array<{ hook: string; kind: SessionRequestKind; agent: Agent.ID }> = []
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "request", kind: event.kind, agent: event.agent })
        }),
      )
      yield* hooks.register("session", "http.response", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "response", kind: event.kind, agent: event.agent })
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      for (const kind of KINDS) {
        const prepared = yield* requests[kind]({
          session,
          agent: Agent.ID.make("build"),
          model,
          system: [],
          messages: [],
        })
        const http = prepared.options.http
        if (!http) throw new Error(`Expected HTTP middleware for ${kind}`)
        yield* http(HttpClientRequest.post("https://example.test/v1/chat/completions"), (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
        )
      }

      expect(seen).toEqual(
        KINDS.flatMap((kind) => [
          { hook: "request", kind, agent: Agent.ID.make("build") },
          { hook: "response", kind, agent: Agent.ID.make("build") },
        ]),
      )
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("sends a kept request's original body and a replaced request's new body", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      let replace = false
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          if (replace) {
            event.request = new Request(event.request.url, { method: "POST", body: '{"replaced":true}' })
            return
          }
          event.request.headers.set("x-plugin", "kept")
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [],
      })
      const http = prepared.options.http
      if (!http) throw new Error("Expected HTTP middleware")
      const original = HttpClientRequest.post("https://example.test/v1/chat/completions").pipe(
        HttpClientRequest.bodyText('{"messages":[]}', "application/json"),
      )
      const send = () => {
        const sent: HttpClientRequest.HttpClientRequest[] = []
        return http(original, (request) =>
          Effect.sync(() => {
            sent.push(request)
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))
          }),
        ).pipe(Effect.map(() => sent[0]!))
      }

      const kept = yield* send()
      expect(kept.body).toBe(original.body)
      expect(kept.headers["x-plugin"]).toBe("kept")

      replace = true
      const replaced = yield* send()
      expect(replaced.body._tag).toBe("Uint8Array")
      if (replaced.body._tag !== "Uint8Array") return
      expect(new TextDecoder().decode(replaced.body.body)).toBe('{"replaced":true}')
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("keeps hook edits to a tool schema out of later requests", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          const input = event.tools.lookup!.input as { required: string[] }
          input.required.push("extra")
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const inputSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      const tools = {
        definitions: [new ToolDefinition({ name: "lookup", description: "Lookup", inputSchema })],
        execute: () => Effect.die("unused tool execution"),
      }

      const required = yield* Effect.forEach([1, 2], () =>
        requests
          .primary({ session, agent: Agent.ID.make("build"), model, system: [], messages: [], tools })
          .pipe(
            Effect.map((prepared) => {
              const tool = prepared.request.tools[0]
              return tool?.type === "tool" ? tool.inputSchema.required : undefined
            }),
          ),
      )

      expect(required).toEqual([
        ["id", "extra"],
        ["id", "extra"],
      ])
      expect(inputSchema.required).toEqual(["id"])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("offers the WebSocket executor alongside HTTP hooks and routes the WebSocket hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "http.request", () => Effect.sync(() => void seen.push("http.request")))
      yield* hooks.register("session", "experimental.ws.handshake", (event) =>
        Effect.sync(() => {
          seen.push(`handshake:${event.kind}:${event.url}`)
          event.headers.authorization = "Bearer minted"
          delete event.headers["api-key"]
        }),
      )
      yield* hooks.register("session", "experimental.ws.send", (event) =>
        Effect.sync(() => {
          seen.push(`send:${event.kind}:${event.frame}`)
          event.frame = `${event.frame}+plugin`
        }),
      )
      yield* hooks.register("session", "experimental.ws.receive", (event) =>
        Effect.sync(() => {
          seen.push(`receive:${event.kind}:${event.frame}`)
          event.frame = event.frame.toUpperCase()
        }),
      )
      const bound: Array<{ url: string; headers: Record<string, string> }> = []
      const frames: string[] = []
      const websocketTransport = SessionModelTransport.Service.of({
        steer: () => Effect.succeed(false),
        hasPendingInput: () => false,
        bind: (_sessionID, interceptor) => ({
          execute: () =>
            Effect.gen(function* () {
              if (!interceptor?.handshake || !interceptor.send || !interceptor.receive)
                throw new Error("Expected a full WebSocket interceptor")
              bound.push(
                yield* interceptor.handshake({ url: "wss://example.test/v1/responses", headers: { "api-key": "k" } }),
              )
              frames.push(yield* interceptor.send("create"))
              frames.push(yield* interceptor.receive("created"))
              return { frames: Stream.empty, complete: Effect.void }
            }),
        }),
        close: () => Effect.void,
        retire: () => Effect.void,
        closeAll: Effect.void,
      })
      const requests = yield* SessionModelRequest.Service.pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, websocketTransport),
      )
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
          transport: "websocket",
        }),
        system: [],
        messages: [],
        webSocket: "session",
      })

      expect(prepared.options.http).toBeDefined()
      expect(prepared.options.webSocket).toBeDefined()
      yield* prepared.options.webSocket!.execute({} as never)
      expect(bound).toEqual([{ url: "wss://example.test/v1/responses", headers: { authorization: "Bearer minted" } }])
      expect(frames).toEqual(["create+plugin", "CREATED"])
      expect(seen).toEqual([
        "handshake:primary:wss://example.test/v1/responses",
        "send:primary:create",
        "receive:primary:created",
      ])
    }),
  )
})
