import { expect } from "bun:test"
import { LanguageModel, LLMClient, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { TestLLM } from "../../ai/src/testing"
import { Bus } from "@opencode/core/bus"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTitle } from "@opencode/core/session/title"
import { Global } from "@opencode/util/global"
import { Context, Deferred, Effect, Layer, Stream } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

it.live("HTTP admit-only steering preserves an active generation and delivers at its boundary across reopening", () => Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const database = `${directory.path}/steering.sqlite`
  const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
  const paused = yield* Deferred.make<void>()
  const cancelled = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const model = SessionRunnerModel.resolved(LanguageModel.make({ id: "fixture", provider: "test", route: OpenAIChat.route }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 8_192 },
  })
  const replacements = [
    Global.node.replace(tempGlobalLayer),
    Bus.node.replace(Bus.configured({ persist: true })),
    llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
    SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, { select: () => Effect.die("unused"), resolve: () => Effect.succeed(model) })),
    SessionTitle.node.replace(Layer.succeed(SessionTitle.Service, { generate: () => Effect.void })),
  ]
  const options = { app: { version: "test" }, database: { path: database }, models: { fetch: false }, fs: { filewatcher: false } }
  const boot = Effect.gen(function* () {
    const context = yield* Layer.build(createEmbeddedRoutes(options, replacements).pipe(Layer.provide(HttpServer.layerServices)))
    const handler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
    const sessions = Context.get(context, Session.Service)
    const request = (route: string, body: unknown) => Effect.promise(async () => {
      const response = await handler(new Request(`http://opencode.local${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
      expect(response.status).toBe(200)
      return response.json() as Promise<{ data: { id: string } }>
    })
    const created = yield* request("/api/session", { location: { directory: directory.path } })
    const sessionID = Session.ID.make(created.data.id)
    yield* llm.push(
      Stream.concat(Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "partial" }), LLMEvent.textDelta({ id: "partial", text: "Old direction" })]),
        Stream.fromEffect(Deferred.succeed(paused, undefined)).pipe(Stream.flatMap(() => Stream.fromEffect(Deferred.await(release))), Stream.flatMap(() => Stream.fromIterable(TestLLM.stop()))))
        .pipe(Stream.ensuring(Deferred.succeed(cancelled, undefined))),
      TestLLM.text("Corrected", "corrected"),
    )
    yield* request(`/api/session/${sessionID}/prompt`, { text: "Original" })
    yield* Deferred.await(paused)
    yield* request(`/api/session/${sessionID}/prompt`, { text: "Correction", resume: false })
    expect(yield* Deferred.isDone(cancelled)).toBe(false)
    expect(yield* llm.requests()).toHaveLength(1)
    expect((yield* sessions.inbox(sessionID))).toHaveLength(1)
    yield* Deferred.succeed(release, undefined)
    yield* sessions.wait(sessionID)
    expect(yield* llm.requests()).toHaveLength(2)
    expect((yield* llm.requests())[1].messages.filter((message) => message.role === "user").flatMap((message) => message.content)).toContainEqual(expect.objectContaining({ text: "Correction" }))
    expect((yield* sessions.messages({ sessionID })).some((message) => message.type === "assistant" && message.interruption === "steer")).toBe(false)
    const pending = yield* request(`/api/session/${sessionID}/prompt`, { text: "Retained", resume: false })
    return { sessionID, pendingID: SessionMessage.ID.make(pending.data.id) }
  })
  const retained = yield* boot.pipe(Effect.scoped)
  const reopened = yield* Layer.build(createEmbeddedRoutes(options, replacements).pipe(Layer.provide(HttpServer.layerServices)))
  const sessions = Context.get(reopened, Session.Service)
  expect((yield* sessions.inbox(retained.sessionID)).map((item) => item.id)).toEqual([retained.pendingID])
  expect((yield* sessions.messages({ sessionID: retained.sessionID })).some((message) => message.type === "assistant" && message.interruption === "steer")).toBe(false)
}))
