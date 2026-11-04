import { expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Session } from "@opencode/core/session"
import { Location } from "@opencode/core/location"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/core/tool"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

// Real Permission, host, adapter and tool registry; only providers remain inert.
const it = testEffect(makePluginTestLayer(null))
for (const mode of [
  "return",
  "throw",
  "interrupt",
  "wrapped",
  "delayed-listener",
  "concurrent",
  "already-aborted",
] as const) {
  it.live(`abort event callbacks cannot revive their invocation (${mode})`, () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
        }),
      )
      const sessions = yield* Session.Service
      const location = yield* Location.Service
      const session = yield* sessions.create({
        agent: Agent.ID.make("build"),
        location: { directory: location.directory },
      })
      const permission = yield* Permission.Service
      const hooks = yield* PluginHooks.Service
      const bus = yield* Bus.Service
      const tools = yield* Tool.Service
      const started = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const firstAsked = yield* Deferred.make<Permission.Request>()
      const secondAsked = yield* Deferred.make<Permission.Request>()
      const asked = yield* Deferred.make<Permission.Request>()
      const settled = Promise.withResolvers<void>()
      const secondSettled = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const signals = new Map<string, AbortSignal>()
      let executions = 0
      let bodyRuns = 0
      let asks = 0
      yield* hooks.registerSourceReviewer(
        (event) =>
          Effect.sync(() => {
            if (event.action !== "event" && event.action !== "initial") return
            event.effect = "deny"
            event.review = { kind: "model-refusal", reason: "Inert eligible abort-event judgement" }
          }),
        () => true,
        true,
      )
      const unsubscribe = yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = event.data as Permission.Request
        if (request.action === "initial")
          return Deferred.succeed(
            request.source?.type === "tool" && request.source.id === "call-second" ? secondAsked : firstAsked,
            request,
          ).pipe(Effect.asVoid)
        asks++
        return Deferred.succeed(asked, request).pipe(Effect.asVoid)
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* PluginPromise.fromPromise({
        id: "owned-abort-events",
        async setup(context) {
          const initial = (invocation: { id: string; messageID: SessionMessage.ID }) =>
            context.permission.assert({
              sessionID: session.id,
              action: "initial",
              resources: ["fixture"],
              source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
              metadata: {
                action: { identity: "initial", arguments: {}, cwd: context.location.directory, complete: true },
              },
            })
          const assertFromEvent = (invocation: { id: string; messageID: SessionMessage.ID; signal: AbortSignal }) => {
            expect(invocation.signal.aborted).toBe(true)
            expect(invocation.signal.reason).toBeDefined()
            return context.permission
              .assert({
                sessionID: session.id,
                action: "event",
                resources: ["fixture"],
                source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
                metadata: {
                  action: { identity: "event", arguments: {}, cwd: context.location.directory, complete: true },
                },
              })
              .then(
                () => {
                  executions++
                },
                (error: unknown) => {
                  expect(error).toBe(invocation.signal.reason)
                },
              )
          }
          await context.tool.transform((editor) => {
            editor.add({
              name: "abort_event",
              description: "Inert abort-event assertion fixture",
              input: { type: "object", properties: {}, additionalProperties: false },
              options: { codemode: false },
              async execute(_input, invocation) {
                bodyRuns++
                if (mode === "already-aborted") {
                  expect(invocation.signal.aborted).toBe(true)
                  await initial(invocation)
                  throw new Error("Aborted assertion continued")
                }
                if (mode === "delayed-listener") await Promise.resolve()
                signals.set(invocation.id, invocation.signal)
                invocation.signal.addEventListener(
                  "abort",
                  () => {
                    void assertFromEvent(invocation).then(() => {
                      if (invocation.id === "call-second") secondSettled.resolve()
                      else settled.resolve()
                    })
                  },
                  { once: true },
                )
                void initial(invocation).catch(() => {})
                Deferred.doneUnsafe(invocation.id === "call-second" ? secondStarted : started, Effect.void)
                await release.promise
                if (mode === "throw") throw new Error("Original abort-event fixture error")
                return { content: "Inert completion" }
              },
            })
            if (mode === "wrapped")
              editor.update("abort_event", (tool) => {
                const original = tool.execute
                tool.execute = async (input, invocation) => {
                  await Promise.resolve()
                  return original(input, invocation)
                }
              })
            if (mode === "already-aborted")
              editor.update("abort_event", (tool) => {
                const original = tool.execute
                tool.execute = (input, invocation) =>
                  new Promise((resolve) => {
                    signals.set(invocation.id, invocation.signal)
                    invocation.signal.addEventListener(
                      "abort",
                      () => {
                        void Promise.all([
                          assertFromEvent(invocation),
                          original(input, invocation).then(
                            () => {
                              throw new Error("Aborted assertion continued")
                            },
                            () => {},
                          ),
                        ]).then(() => {
                          settled.resolve()
                          resolve({ content: "Closed" })
                        })
                      },
                      { once: true },
                    )
                    void initial(invocation).catch(() => {})
                    Deferred.doneUnsafe(started, Effect.void)
                  })
              })
          })
        },
      }).effect(yield* PluginHost.make(yield* Plugin.Service))
      const snapshot = yield* tools.snapshot()
      const execute = (id: string) =>
        snapshot.execute({
          sessionID: session.id,
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.create(),
          call: { type: "tool-call", id, name: "abort_event", input: {} },
        })
      const first = yield* execute("call-first").pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const firstRequest = yield* Deferred.await(firstAsked)
      const second = mode === "concurrent" ? yield* execute("call-second").pipe(Effect.forkScoped) : undefined
      if (second) {
        yield* Deferred.await(secondStarted)
        yield* Deferred.await(secondAsked)
      }
      if (mode === "interrupt" || mode === "wrapped" || mode === "concurrent" || mode === "already-aborted")
        yield* Fiber.interrupt(first)
      else release.resolve()
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(mode === "return" || mode === "delayed-listener")
      // Either the owned rejection settled or the buggy standalone path created a real request.
      const escaped = yield* Effect.raceFirst(
        Effect.promise(() => settled.promise).pipe(Effect.as(undefined)),
        Deferred.await(asked),
      )
      if (escaped) yield* permission.reply({ requestID: escaped.id, reply: "review_once" }, true)
      const late = yield* permission
        .reply({ requestID: firstRequest.id, reply: "review_once" }, true)
        .pipe(Effect.result)
      yield* Effect.promise(() => settled.promise)
      expect(late._tag).toBe("Failure")
      if (late._tag === "Failure") expect(late.failure._tag).toBe("Permission.NotFoundError")
      if (second) {
        expect(signals.get("call-second")?.aborted).toBe(false)
        release.resolve()
        expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true)
        yield* Effect.promise(() => secondSettled.promise)
      }
      expect(asks).toBe(0)
      expect(yield* permission.list()).toEqual([])
      expect(executions).toBe(0)
      expect(bodyRuns).toBe(mode === "concurrent" ? 2 : 1)
    }),
  )
}

for (const mode of ["interrupt", "return", "throw", "grant", "grant-cancel", "wrapped", "concurrent"] as const) {
  it.live(`invocation assertions settle before ${mode} and cannot revive afterwards`, () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
        }),
      )
      const sessions = yield* Session.Service
      const location = yield* Location.Service
      const session = yield* sessions.create({
        agent: Agent.ID.make("build"),
        location: { directory: location.directory },
      })
      const service = yield* Permission.Service
      const tools = yield* Tool.Service
      const bus = yield* Bus.Service
      const hooks = yield* PluginHooks.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const askedSecond = yield* Deferred.make<Permission.Request>()
      const release = Promise.withResolvers<void>()
      const late = Promise.withResolvers<void>()
      const lateSettled = Promise.withResolvers<void>()
      const assertionSettled = Promise.withResolvers<void>()
      let executions = 0
      let cleaned = 0
      let delayed: (() => Promise<void>) | undefined
      let standalone: (() => Promise<void>) | undefined
      let asks = 0
      yield* hooks.registerSourceReviewer(
        (event) =>
          Effect.sync(() => {
            if (event.action !== "read") return
            event.effect = "deny"
            event.review = { kind: "model-refusal", reason: "Synthetic eligible judgement" }
          }),
        () => true,
        true,
      )
      const unsubscribe = yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = event.data as Permission.Request
        return request.action === "read"
          ? Deferred.succeed(asks++ === 0 ? asked : askedSecond, request).pipe(Effect.asVoid)
          : Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* PluginPromise.fromPromise({
        id: "owned-assertions",
        async setup(context) {
          standalone = () =>
            context.permission.assert({ sessionID: session.id, action: "external", resources: ["fixture"] })
          await context.tool.transform((editor) => {
            editor.add({
              name: "guarded",
              description: "Inert permission lifecycle fixture",
              input: { type: "object", properties: {}, additionalProperties: false },
              options: { codemode: false },
              async execute(_input, invocation) {
                await Promise.resolve()
                const assert = () =>
                  context.permission
                    .assert({
                      sessionID: session.id,
                      action: "read",
                      resources: ["fixture"],
                      source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
                      metadata: {
                        action: { identity: "read", arguments: {}, cwd: context.location.directory, complete: true },
                      },
                    })
                    .then(() => {
                      executions++
                    })
                    .finally(() => {
                      cleaned++
                      assertionSettled.resolve()
                    })
                // A delayed callback retains the originating async store after outer settlement.
                void late.promise
                  .then(() => assert())
                  .then(
                    () => lateSettled.resolve(),
                    () => lateSettled.resolve(),
                  )
                delayed = assert
                const pending = assert()
                void pending.catch(() => {})
                if (mode === "return" || mode === "throw") {
                  await release.promise
                  if (mode === "throw") throw new Error("fixture failure")
                } else await pending
                if (mode === "grant-cancel") await release.promise
                return { content: "Inert completion" }
              },
            })
            if (mode === "wrapped")
              editor.update("guarded", (tool) => {
                const original = tool.execute
                tool.execute = async (input, invocation) => {
                  await Promise.resolve()
                  return original(input, invocation)
                }
              })
          })
        },
      }).effect(yield* PluginHost.make(yield* Plugin.Service))
      const snapshot = yield* tools.snapshot()
      const execute = (id: string) =>
        snapshot.execute({
          sessionID: session.id,
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.create(),
          call: { type: "tool-call", id, name: "guarded", input: {} },
        })
      const fiber = yield* execute("call_owned_assertion").pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      expect(request.action).toBe("read")
      expect(request.review?.kind).toBe("model-refusal")
      expect(yield* service.get(request.id)).toBeDefined()
      const second = mode === "concurrent" ? yield* execute("call_other_assertion").pipe(Effect.forkScoped) : undefined
      const secondRequest = second ? yield* Deferred.await(askedSecond) : undefined
      if (mode === "grant" || mode === "grant-cancel") {
        yield* service.reply({ requestID: request.id, reply: "review_once" }, true)
        if (mode === "grant-cancel") {
          yield* Effect.promise(() => assertionSettled.promise)
          yield* Fiber.interrupt(fiber)
        }
      } else if (mode === "return" || mode === "throw") release.resolve()
      else yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(mode === "grant" || mode === "return")
      expect(yield* service.get(request.id)).toBeUndefined()
      expect((yield* service.list()).map((item) => item.id)).toEqual(secondRequest ? [secondRequest.id] : [])
      const reply = yield* service.reply({ requestID: request.id, reply: "review_once" }, true).pipe(Effect.result)
      expect(reply._tag).toBe("Failure")
      if (reply._tag === "Failure") expect(reply.failure._tag).toBe("Permission.NotFoundError")
      expect(executions).toBe(mode === "grant" || mode === "grant-cancel" ? 1 : 0)
      yield* Effect.promise(() => assertionSettled.promise)
      expect(cleaned).toBe(1)
      if (second && secondRequest) {
        expect(yield* service.get(secondRequest.id)).toBeDefined()
        yield* service.reply({ requestID: secondRequest.id, reply: "review_once" }, true)
        expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true)
        expect(executions).toBe(1)
      }
      late.resolve()
      // Calling outside the tool's async store remains an ordinary standalone assertion;
      // only the callback created inside the invocation must stay closed.
      expect(delayed).toBeDefined()
      yield* Effect.promise(() => lateSettled.promise)
      expect(yield* service.list()).toEqual([])
      expect(executions).toBe(mode === "grant" || mode === "grant-cancel" || mode === "concurrent" ? 1 : 0)
      if (mode === "grant") {
        const external = yield* service.ask({ sessionID: session.id, action: "external", resources: ["fixture"] })
        expect(external.effect).toBe("ask")
        expect(yield* service.get(external.id)).toBeDefined()
        yield* service.reply({ requestID: external.id, reply: "once" }, true)
        const standaloneAsked = yield* Deferred.make<Permission.Request>()
        const stop = yield* bus.listen((event) => {
          if (event.type !== Permission.Event.Asked.type) return Effect.void
          const request = event.data as Permission.Request
          return request.action === "external"
            ? Deferred.succeed(standaloneAsked, request).pipe(Effect.asVoid)
            : Effect.void
        })
        yield* Effect.addFinalizer(() => stop)
        const pending = yield* Effect.promise(() => standalone!()).pipe(Effect.forkScoped)
        const standaloneRequest = yield* Deferred.await(standaloneAsked)
        yield* service.reply({ requestID: standaloneRequest.id, reply: "once" }, true)
        expect(Exit.isSuccess(yield* Fiber.await(pending))).toBe(true)
      }
    }),
  )
}
