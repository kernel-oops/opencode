import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import { AIError, InvalidRequestError, LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionExecution } from "@opencode/core/session/execution"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Review complete", "review") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        Session.node,
        Job.node,
        LocationServiceMap.node,
        Bus.node,
        SubagentJob.node,
        SessionExecution.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        LayerNodePlatform.llmClient.replace(llmLayer),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "review", provider: "test", route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 32_000 },
                  },
                ),
              ),
          }),
        ),
      ],
    ),
  ),
)

describe("subagent observer lifetime", () => {
  for (const mode of [
    "complete",
    "cancel",
    "manual-background",
    "concurrent",
    "hook-error",
    "hook-interrupt",
    "pending",
    "failed",
    "admission barrier",
  ] as const) {
    it.live(`a foreground continuation owns exact admission and delivery (${mode})`, () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* Effect.promise(() =>
          Bun.write(
            `${directory.path}/opencode.json`,
            JSON.stringify({
              agents: { reviewer: { mode: "subagent" } },
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            }),
          ),
        )
        const sessions = yield* Session.Service
        const locations = yield* LocationServiceMap.Service
        const jobs = yield* Job.Service
        const llm = yield* TestLLM.Test
        const bus = yield* Bus.Service
        const parent = yield* sessions.create({
          location: { directory: AbsolutePath.make(directory.path) },
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") }),
        })
        const child = yield* sessions.create({ parentID: parent.id, agent: Agent.ID.make("reviewer") })
        yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(
          Effect.provide(locations.get(parent.location)),
        )
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* llm.push(
          TestLLM.text("Earlier answer", "earlier"),
          mode === "failed"
            ? TestLLM.failAfter(
                new AIError({ reason: new InvalidRequestError({ message: "Inert rejected response" }) }),
              )
            : TestLLM.text("Continuation answer", "continued"),
        )
        const initial = yield* llm.gate()
        const call = (id: string, background: boolean, prompt: string) =>
          executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id,
              name: "subagent",
              input: {
                agent: "reviewer",
                sessionID: child.id,
                description: "Continuation fixture",
                prompt,
                background,
              },
            },
          })
        expect((yield* call("call-initial-background", true, "Original exact task")).status).toBe("completed")
        yield* initial.started
        const original = yield* jobs.get(child.id)
        if (mode === "admission barrier") {
          yield* jobs.pause(parent.id)
          let waiter: Fiber.Fiber<unknown, unknown> | undefined
          let admissions = 0
          let notices = 0
          const remove = yield* bus.listen((event) =>
            Effect.sync(() => {
              if (event.type !== SessionEvent.InboxEnqueued.type) return
              const admitted = event as SessionEvent.InboxEnqueued
              if (
                admitted.data.sessionID === child.id &&
                admitted.data.item.type === "user" &&
                admitted.data.item.payload.text === "Cancelled at admission barrier"
              ) {
                admissions++
                waiter!.interruptUnsafe()
              }
              if (admitted.data.sessionID === parent.id && admitted.data.item.type === "synthetic") notices++
            }),
          )
          yield* Effect.addFinalizer(() => remove)
          waiter = yield* call("call-admission-cancel", false, "Cancelled at admission barrier").pipe(Effect.forkScoped)
          const result = yield* Fiber.await(waiter)
          expect(Exit.hasInterrupts(result)).toBe(true)
          expect(admissions).toBe(1)
          yield* sessions.wait(child.id)
          yield* initial.release
          const execution = yield* SessionExecution.Service
          expect(yield* execution.isActive(child.id)).toBe(false)
          expect(yield* jobs.pendingBackground).toEqual([])
          expect(notices).toBe(0)
          expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toEqual([])
          expect(yield* llm.requests()).toHaveLength(1)
          return
        }
        if (mode === "pending") {
          yield* jobs.pause(parent.id)
          yield* initial.release
          yield* jobs.wait({ id: child.id })
          yield* sessions.wait(child.id)
          const admitted = yield* sessions.prompt({
            sessionID: child.id,
            text: "Undelivered continuation",
            resume: false,
          })
          const subagents = yield* SubagentJob.Service
          const handle = yield* subagents.start(
            {
              kind: "subagent",
              parentSessionID: parent.id,
              childSessionID: child.id,
              agent: "reviewer",
              description: "Pending fixture",
            },
            { foreground: parent.id, admissionID: admitted.id, admitOnly: false },
          )
          expect(yield* handle.block).toMatchObject({ type: "finished", info: { status: "error" } })
          expect((yield* sessions.inbox(child.id)).filter((item) => item.type === "user")).toHaveLength(1)
          expect(yield* llm.requests()).toHaveLength(1)
          return
        }
        if (mode === "hook-error" || mode === "hook-interrupt") {
          const entered = yield* Deferred.make<void>()
          const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* hooks.register("session", "prompt", (event) =>
            event.prompt.text === "Exact non-empty continuation"
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(
                    mode === "hook-error" ? Effect.die(new Error("Inert admission failure")) : Effect.never,
                  ),
                )
              : Effect.void,
          )
          const rejected = yield* call("call-rejected-continuation", false, "Exact non-empty continuation").pipe(
            Effect.forkScoped,
          )
          yield* Deferred.await(entered)
          if (mode === "hook-interrupt") yield* Fiber.interrupt(rejected)
          expect(Exit.isFailure(yield* Fiber.await(rejected))).toBe(true)
          expect(yield* jobs.runningBackground).toHaveLength(1)
          expect(
            (yield* sessions.messages({ sessionID: child.id }))
              .filter((message) => message.type === "user")
              .map((message) => message.text),
          ).toEqual(["Original exact task"])
          yield* initial.release
          yield* llm.wait(2)
          yield* sessions.wait(parent.id)
          expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toHaveLength(1)
          expect(yield* jobs.pendingBackground).toEqual([])
          return
        }
        const admitted = yield* Deferred.make<void>()
        let admissions = 0
        yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
          Stream.filter(
            (event) =>
              event.data.sessionID === child.id &&
              event.data.item.type === "user" &&
              event.data.item.payload.text.startsWith("Exact non-empty continuation"),
          ),
          Stream.tap(() =>
            ++admissions === (mode === "concurrent" ? 2 : 1) ? Deferred.succeed(admitted, undefined) : Effect.void,
          ),
          Stream.take(mode === "concurrent" ? 2 : 1),
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true }),
        )
        const next = yield* llm.gate()
        const waiter = yield* call("call-foreground-continuation", false, "Exact non-empty continuation").pipe(
          Effect.forkScoped,
        )
        const secondWaiter =
          mode === "concurrent"
            ? yield* call("call-second-continuation", false, "Exact non-empty continuation two").pipe(Effect.forkScoped)
            : undefined
        yield* Deferred.await(admitted)
        yield* initial.release
        yield* next.started
        expect(yield* jobs.get(child.id)).toMatchObject({
          status: "running",
          started_at: original!.started_at,
          notificationID: original!.notificationID,
        })
        expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toEqual([])
        expect(yield* jobs.runningBackground).toEqual([])
        if (mode === "cancel") {
          yield* Fiber.interrupt(waiter)
          yield* sessions.wait(child.id)
          expect(yield* jobs.pendingBackground).toEqual([])
          expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toEqual([])
          return
        }
        if (mode === "manual-background") {
          yield* jobs.pause(parent.id)
          yield* sessions.background(parent.id)
          expect((yield* Fiber.join(waiter)).metadata?.status).toBe("running")
          expect(yield* jobs.runningBackground).toHaveLength(1)
          const notification = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild({ startImmediately: true }),
          )
          yield* next.release
          yield* Fiber.join(notification)
          yield* sessions.wait(child.id)
          expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toHaveLength(1)
          expect(yield* llm.requests()).toHaveLength(2)
          return
        }
        yield* next.release
        const result = yield* Fiber.join(waiter)
        if (mode === "failed") {
          expect(result.status).toBe("error")
          expect(result.content).toBeUndefined()
          expect(yield* jobs.pendingBackground).toEqual([])
          return
        }
        if (secondWaiter) expect((yield* Fiber.join(secondWaiter)).content).toEqual(result.content)
        expect(result).toMatchObject({ status: "completed", metadata: { sessionID: child.id, status: "completed" } })
        expect(result.content).toEqual([
          {
            type: "text",
            text: `<subagent sessionID="${child.id}" state="completed">\nContinuation answer\n</subagent>`,
          },
        ])
        expect(
          (yield* sessions.messages({ sessionID: child.id, order: "asc" }))
            .filter((message) => message.type === "user")
            .map((message) => message.text),
        ).toEqual([
          "Original exact task",
          "Exact non-empty continuation",
          ...(mode === "concurrent" ? ["Exact non-empty continuation two"] : []),
        ])
        expect(yield* jobs.pendingBackground).toEqual([])
        expect((yield* sessions.inbox(parent.id)).filter((item) => item.type === "synthetic")).toEqual([])
        expect(yield* llm.requests()).toHaveLength(2)
      }),
    )
  }

  for (const [evict, outcome] of [
    [false, "completed"],
    [true, "completed"],
    [true, "cancelled"],
  ] as const) {
    it.live(
      `notifies an idle parent exactly once after its moved child ${outcome} (evict=${evict})`,
      () =>
        Effect.gen(function* () {
          const parentDir = yield* tmpdirScoped()
          const childDir = yield* tmpdirScoped()
          yield* Effect.promise(() =>
            Bun.write(
              `${parentDir.path}/opencode.json`,
              JSON.stringify({
                agents: { reviewer: { mode: "subagent" } },
                permissions: [{ action: "*", resource: "*", effect: "allow" }],
              }),
            ),
          )
          yield* Effect.promise(() =>
            Bun.write(`${childDir.path}/opencode.json`, JSON.stringify({ agents: { reviewer: { mode: "subagent" } } })),
          )
          const sessions = yield* Session.Service
          const locations = yield* LocationServiceMap.Service
          const jobs = yield* Job.Service
          const llm = yield* TestLLM.Test
          const parent = yield* sessions.create({
            location: { directory: AbsolutePath.make(parentDir.path) },
            agent: Agent.ID.make("build"),
            model: Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") }),
          })
          const child = yield* sessions.create({ parentID: parent.id, agent: Agent.ID.make("reviewer") })
          yield* sessions.move({ sessionID: child.id, directory: AbsolutePath.make(childDir.path) })
          yield* sessions.wait(child.id)
          expect((yield* sessions.get(child.id)).location.directory).toBe(AbsolutePath.make(childDir.path))
          yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(
            Effect.provide(locations.get(parent.location)),
          )
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const gate = yield* llm.gate()
          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-review",
              name: "subagent",
              input: {
                agent: "reviewer",
                sessionID: child.id,
                description: "Review fixture",
                prompt: "Review the fixture",
                background: true,
              },
            },
          })
          expect(result.status).toBe("completed")
          yield* gate.started
          expect(yield* sessions.context(parent.id)).toEqual([])
          if (evict) {
            yield* locations.invalidate(parent.location)
            // Rebuilding a location must not lose or duplicate its former observer.
            yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(
              Effect.provide(locations.get(parent.location)),
            )
            yield* locations.invalidate(parent.location)
          }
          if (outcome === "cancelled") yield* jobs.cancel(child.id)
          yield* gate.release
          yield* jobs.wait({ id: child.id })
          yield* llm.wait(2).pipe(Effect.timeout("2 seconds"))
          yield* sessions.wait(parent.id)
          const notices = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(notices).toHaveLength(1)
          expect(notices[0]).toMatchObject({ metadata: { source: "subagent", childID: child.id, state: outcome } })
          expect(yield* jobs.pendingBackground).toEqual([])
          yield* locations.invalidate(parent.location)
          yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(
            Effect.provide(locations.get(parent.location)),
          )
          expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toEqual(
            notices,
          )
          expect(yield* llm.requests()).toHaveLength(2)
        }),
      20_000,
    )
  }
})
