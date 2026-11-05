import { expect, test } from "bun:test"
import type { AIError } from "@opencode/ai/effect"
import type { ChannelObservation, WebSocketChannelExchange, WebSocketConnector } from "@opencode/ai/route"
import { Context, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { Headers } from "effect/http"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Job } from "@opencode/core/job"
import { Instance } from "@opencode/core/instance/service"
import { Session } from "@opencode/schema/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionStore } from "@opencode/core/session/store"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionNativeTest } from "@opencode/core/session/native-test"
import { SessionNativeTest as Contract } from "@opencode/schema/session-native-test"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionTable } from "@opencode/core/session/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { testEffect } from "./lib/effect"

const on = { nativeSteer: "response.steer", debug: "metadata" } as const
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Job.node, SessionStore.node, SessionInbox.node, SessionNativeTest.node])))

/** Real SessionExecution ownership with a barrier-controlled runner and a transport that records retirements. */
const harness = (ids: ReadonlyArray<Session.ID>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const registry = yield* SessionNativeTest.Service
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).onConflictDoNothing().run()
    for (const id of ids)
      yield* database.db.insert(SessionTable).values({ id, project_id: Project.ID.global, slug: id, directory: "/fixture", version: "test" }).run()
    let entered = yield* Deferred.make<void>()
    let release = yield* Deferred.make<void>()
    const seen: Array<Contract.Settings> = []
    const retired: Array<{ readonly sessionID: Session.ID; readonly generation: number }> = []
    const runner = SessionRunner.Service.of({
      drain: (input) =>
        Effect.gen(function* () {
          seen.push(registry.policy(input.sessionID))
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          seen.push(registry.policy(input.sessionID))
          return SessionRunner.DrainResult.Complete()
        }),
    })
    const provide = (() => Effect.provideService(SessionRunner.Service, runner)) as Instance.Interface["provide"]
    const transport = SessionModelTransport.Service.of({
      steer: () => Effect.succeed(false),
      hasPendingInput: () => false,
      bind: () => ({ execute: () => Effect.die("unused") }),
      close: () => Effect.void,
      retire: (sessionID, generation) => Effect.sync(() => retired.push({ sessionID, generation })),
      closeAll: Effect.void,
    })
    const services = yield* Layer.build(
      Layer.fresh(SessionExecution.layer).pipe(
        Layer.provide(Layer.succeed(Instance.Service, Instance.Service.of({ provide }))),
        Layer.provide(Layer.succeed(SessionModelTransport.Service, transport)),
      ),
    )
    const execution = Context.get(services, SessionExecution.Service)
    const barrier = Effect.gen(function* () {
      entered = yield* Deferred.make<void>()
      release = yield* Deferred.make<void>()
    })
    return {
      registry,
      execution,
      seen,
      retired,
      barrier,
      entered: () => Deferred.await(entered),
      release: () => Deferred.succeed(release, undefined),
    }
  })

it.effect("enabling during a fresh or previously opted-out off execution reports it active and pending", () =>
  Effect.gen(function* () {
    const id = Session.ID.make("ses_native_exec_off")
    const h = yield* harness([id])
    const running = yield* h.execution.resume(id).pipe(Effect.forkScoped)
    yield* h.entered()
    yield* h.registry.request(id, on)
    expect(h.registry.inspect(id)).toMatchObject({
      requested: on,
      effective: Contract.off,
      pending: true,
      execution: { active: true, settings: Contract.off },
    })
    // The running execution keeps its off snapshot.
    expect(h.registry.policy(id)).toEqual(Contract.off)
    yield* h.release()
    yield* Fiber.join(running)
    expect(h.registry.inspect(id)).toMatchObject({ pending: false, execution: { active: false } })

    // The next busy period applies the request, then an idle opt-out is forgotten after an off run.
    yield* h.barrier
    yield* h.execution.resume(id).pipe(Effect.forkScoped)
    yield* h.entered()
    expect(h.registry.inspect(id)).toMatchObject({ effective: on, pending: false, execution: { active: true } })
    yield* h.release()
    yield* h.execution.awaitIdle(id)
    yield* h.registry.request(id, Contract.off)
    yield* h.barrier
    const off = yield* h.execution.resume(id).pipe(Effect.forkScoped)
    yield* h.entered()
    yield* h.release()
    yield* Fiber.join(off)
    expect(h.registry.inspect(id).execution).toBeUndefined()

    // Another off execution of the opted-out session: enabling mid-run is pending again.
    yield* h.barrier
    const again = yield* h.execution.resume(id).pipe(Effect.forkScoped)
    yield* h.entered()
    yield* h.registry.request(id, { nativeSteer: false, debug: "metadata" })
    expect(h.registry.inspect(id)).toMatchObject({ pending: true, execution: { active: true, settings: Contract.off } })
    yield* h.release()
    yield* Fiber.join(again)
    expect(h.seen).toEqual([Contract.off, Contract.off, on, on, Contract.off, Contract.off, Contract.off, Contract.off])
  }),
  { timeout: 5_000 },
)

it.effect("interruption clears the active snapshot and every start passes its generation to transport retirement", () =>
  Effect.gen(function* () {
    const id = Session.ID.make("ses_native_exec_interrupt")
    const other = Session.ID.make("ses_native_exec_other")
    const h = yield* harness([id, other])
    yield* h.registry.request(id, on)
    yield* h.execution.wake(id)
    yield* h.entered()
    const generation = h.registry.generation(id)
    expect(generation).toBeGreaterThan(0)
    yield* h.registry.request(id, Contract.off)
    expect(h.registry.inspect(id)).toMatchObject({ requested: Contract.off, effective: on, pending: true, execution: { active: true } })
    // A pending disable keeps the reservation; it is neither pruned nor taken over.
    expect(yield* h.registry.request(other, on).pipe(Effect.isFailure)).toBe(true)
    yield* h.execution.interrupt(id)
    yield* h.execution.awaitIdle(id)
    expect(h.registry.policy(id)).toEqual(Contract.off)
    expect(h.registry.inspect(id)).toMatchObject({ pending: false, execution: { active: false } })
    yield* h.registry.request(other, on)
    expect(h.retired).toEqual([{ sessionID: id, generation }])
  }),
  { timeout: 5_000 },
)

const exchange = (id: string): WebSocketChannelExchange => ({
  id,
  connect: { url: "wss://provider.test/responses", headers: Headers.fromInput({}) },
  fallback: () => Stream.make(`fallback:${id}`),
  driver: {
    create: () => Effect.succeed({ message: id, mode: "full" }),
    observe: (_create, frame): Effect.Effect<ChannelObservation, AIError> => Effect.succeed({ type: "completed", frame }),
  },
})

test("the execution boundary retires a stale native channel even when the next execution uses HTTP", async () => {
  const registry = SessionNativeTest.make()
  const id = Session.ID.make("ses_native_exec_retire")
  const other = Session.ID.make("ses_native_exec_retire_other")
  let closed = 0
  let opened = 0
  const connector: WebSocketConnector = {
    open: () =>
      Effect.gen(function* () {
        opened++
        const messages = yield* Queue.unbounded<string | Uint8Array, AIError>()
        return {
          sendText: (message: string) => Effect.sync(() => Queue.offerUnsafe(messages, `completed:${message}`)),
          messages: Stream.fromQueue(messages),
          close: Effect.sync(() => {
            closed++
          }).pipe(Effect.andThen(Queue.shutdown(messages)), Effect.asVoid),
        }
      }),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const transport = yield* SessionModelTransport.Service
      const collect = (sessionID: Session.ID, item: WebSocketChannelExchange) =>
        Effect.gen(function* () {
          const execution = yield* transport.bind(sessionID).execute(item)
          return yield* Stream.runCollect(execution.frames)
        }).pipe(Effect.scoped)
      yield* registry.request(id, on)
      yield* registry.start(id)
      yield* transport.retire(id, registry.generation(id))
      yield* collect(id, exchange("native"))
      yield* registry.start(other)
      yield* transport.retire(other, registry.generation(other))
      yield* collect(other, exchange("other"))
      yield* registry.finish(id)
      yield* registry.request(id, Contract.off)
      // Same generation again (no change): nothing is retired.
      yield* registry.finish(other)
      yield* registry.start(other)
      yield* transport.retire(other, registry.generation(other))
      expect(closed).toBe(0)
      // The opted-out session's next execution starts; no WebSocket exchange follows (HTTP).
      yield* registry.start(id)
      yield* transport.retire(id, registry.generation(id))
      expect(closed).toBe(1)
      expect(opened).toBe(2)
      // Retirement is idempotent for the same execution generation.
      yield* transport.retire(id, registry.generation(id))
      expect(closed).toBe(1)
    }).pipe(Effect.provide(SessionModelTransport.makeLayer(connector, registry)), Effect.scoped),
  )
})

test("exchange diagnostics retain sends and automatic successors without progress tracking", async () => {
  const registry = SessionNativeTest.make(() => 0)
  const id = Session.ID.make("ses_native_exec_progress")
  await Effect.runPromise(registry.request(id, on))
  await Effect.runPromise(registry.start(id))
  registry.observe(id, { kind: "send" })
  registry.observe(id, { kind: "send" })
  registry.observe(id, { kind: "adopt" })
  const diagnostics = registry.inspect(id).diagnostics
  expect(diagnostics.progress).toBe(0)
  expect(diagnostics.coalesced).toBe(0)
  expect(diagnostics.records.filter((record) => record.kind === "send" || record.kind === "adopt").map((record) => record.exchange)).toEqual([1, 2, 3])
  await Effect.runPromise(registry.finish(id))
  await Effect.runPromise(registry.start(id))
  expect(registry.inspect(id).diagnostics.progress).toBe(0)
})

test("idle opted-out histories are pruned so retained diagnostics stay bounded", async () => {
  const registry = SessionNativeTest.make()
  const ids = Array.from({ length: 12 }, (_, index) => Session.ID.make(`ses_native_exec_retained_${index}`))
  for (const id of ids) {
    await Effect.runPromise(registry.request(id, on))
    await Effect.runPromise(registry.start(id))
    for (let index = 0; index < 260; index++) registry.observe(id, { kind: "send" })
    await Effect.runPromise(registry.finish(id))
    await Effect.runPromise(registry.request(id, Contract.off))
  }
  const retained = ids.reduce((sum, id) => sum + registry.inspect(id).diagnostics.records.length, 0)
  expect(retained).toBe(SessionNativeTest.RING_SIZE)
  // The latest history is kept until another lane is created.
  expect(registry.inspect(ids.at(-1)!).diagnostics.records).toHaveLength(SessionNativeTest.RING_SIZE)
})
