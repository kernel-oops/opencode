import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { SessionSubagentCompletion } from "./lib/subagent-completion"
import { SessionTaskControl } from "@opencode/core/session/task-control"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"

const calls = { interrupted: [] as string[], woken: [] as string[] }

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      bindInterrupt: () => Effect.succeed(() => Effect.succeed(false)),
      resume: () => Effect.void,
      wake: (sessionID) => Effect.sync(() => void calls.woken.push(sessionID)),
      interrupt: (sessionID) => Effect.sync(() => (calls.interrupted.push(sessionID), true)),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      KV.node,
      Session.node,
      SessionStore.node,
      SessionExecution.node,
      SessionTaskControl.node,
      LocationServiceMap.node,
    ]),
    [SessionExecution.node.replace(executionNode), Global.node.replace(tempGlobalLayer), offlineModels],
  ),
)

const withDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(dir.path)))

describe("SessionTaskControl", () => {
  it.live("pauses delivery on stop-response, retains completions, and delivers them on resume", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        calls.interrupted.length = 0
        calls.woken.length = 0
        const sessions = yield* Session.Service
        const jobs = yield* Job.Service
        const control = yield* SessionTaskControl.Service
        const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
        const child = yield* sessions.create({ parentID: parent.id, title: "background review" })
        const recovery = {
          kind: "subagent" as const,
          parentSessionID: parent.id,
          childSessionID: child.id,
          agent: "reviewer",
          description: "background review",
        }
        const latch = yield* Deferred.make<void>()
        yield* jobs.start({
          id: child.id,
          type: "subagent",
          title: recovery.description,
          recovery,
          run: Deferred.await(latch).pipe(Effect.as("child result")),
        })
        yield* jobs.background(child.id)

        expect(yield* control.status(parent.id)).toEqual({
          paused: false,
          active: false,
          background: [{ sessionID: child.id, agent: "reviewer", description: "background review", status: "running" }],
        })

        expect(yield* control.stopResponse(parent.id)).toEqual({ interrupted: true, paused: true })
        expect(calls.interrupted).toEqual([parent.id])
        expect(yield* jobs.paused(parent.id)).toBe(true)
        expect((yield* control.status(parent.id)).paused).toBe(true)

        // Background work survives the response stop and completes while paused.
        yield* Deferred.succeed(latch, undefined)
        const finished = yield* jobs.wait({ id: child.id })
        expect(finished.info?.status).toBe("completed")
        yield* SessionSubagentCompletion.deliver(sessions, jobs, { ...finished.info!, recovery })
        const retained = yield* sessions.inbox(parent.id)
        expect(retained.map((item) => item.type)).toEqual(["synthetic"])
        expect(calls.woken).toEqual([])

        expect(yield* control.resume(parent.id)).toEqual({ resumed: true })
        expect(calls.woken).toEqual([parent.id])
        expect(yield* jobs.paused(parent.id)).toBe(false)
        expect(yield* control.resume(parent.id)).toEqual({ resumed: false })
      }),
    ),
  )

  it.live("stop-all cancels the owned job tree and suppresses its notifications", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        calls.interrupted.length = 0
        calls.woken.length = 0
        const sessions = yield* Session.Service
        const jobs = yield* Job.Service
        const control = yield* SessionTaskControl.Service
        const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
        const child = yield* sessions.create({ parentID: parent.id, title: "child" })
        const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })
        const sibling = yield* sessions.create({ location: parent.location, title: "other controller" })
        const siblingChild = yield* sessions.create({ parentID: sibling.id, title: "sibling child" })
        const start = (parentSessionID: Session.ID, childSessionID: Session.ID) =>
          Effect.gen(function* () {
            const recovery = {
              kind: "subagent" as const,
              parentSessionID,
              childSessionID,
              agent: "reviewer",
              description: childSessionID,
            }
            const latch = yield* Deferred.make<void>()
            yield* jobs.start({
              id: childSessionID,
              type: "subagent",
              recovery,
              run: Deferred.await(latch).pipe(Effect.as("x")),
            })
            yield* jobs.background(childSessionID)
            return recovery
          })
        const childRecovery = yield* start(parent.id, child.id)
        yield* start(child.id, grandchild.id)
        yield* start(sibling.id, siblingChild.id)
        expect(yield* jobs.pendingBackground).toHaveLength(3)

        const result = yield* control.stopAll(parent.id)
        expect(result.interrupted).toBe(true)
        expect(result.cancelled).toEqual([grandchild.id, child.id])
        expect(calls.interrupted).toEqual([grandchild.id, child.id, parent.id])
        const cancelled = yield* jobs.get(child.id)
        expect(cancelled).toMatchObject({ status: "cancelled", metadata: { suppressed: true } })
        // No marker for the cancelled tree remains for restart recovery; the other controller keeps its job.
        expect((yield* jobs.pendingBackground).map((job) => job.id)).toEqual([siblingChild.id])
        expect(yield* jobs.get(siblingChild.id)).toMatchObject({ status: "running" })

        yield* SessionSubagentCompletion.deliver(sessions, jobs, { ...cancelled!, recovery: childRecovery })
        expect(yield* sessions.inbox(parent.id)).toEqual([])
        expect(calls.woken).toEqual([])
      }),
    ),
  )

  it.live("reports missing sessions", () =>
    Effect.gen(function* () {
      const control = yield* SessionTaskControl.Service
      const exit = yield* control.status(Session.ID.make("ses_missing")).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
