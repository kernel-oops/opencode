import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, RcMap, Schedule } from "effect"
import fs from "node:fs/promises"
import { eq } from "drizzle-orm"
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
import { Instance } from "@opencode/core/instance/service"
import { Shell } from "@opencode/core/shell"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { SessionTable } from "@opencode/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"

const calls = {
  forceLive: undefined as string | undefined,
  interruptResult: true,
  interrupted: [] as string[],
  woken: [] as string[],
  onInterrupt: undefined as ((sessionID: string) => Effect.Effect<void>) | undefined,
}

const instanceNode = makeGlobalNode({
  service: Instance.Service,
  layer: Layer.effect(
    Instance.Service,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return Instance.Service.of({
        provide: (session) => Effect.provide(locations.get(session.location)),
        live: (session) =>
          calls.forceLive === session.location.directory
            ? Effect.succeed(true)
            : RcMap.has(locations.rcMap, LocationServiceMap.canonical(session.location)),
      })
    }),
  ),
  deps: [LocationServiceMap.node],
})

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: (sessionID) => Effect.sync(() => void calls.woken.push(sessionID)),
      interrupt: (sessionID) =>
        Effect.suspend(() => calls.onInterrupt?.(sessionID) ?? Effect.void).pipe(
          Effect.andThen(Effect.sync(() => (calls.interrupted.push(sessionID), calls.interruptResult))),
        ),
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
      Instance.node,
      LocationServiceMap.node,
    ]),
    [
      SessionExecution.node.replace(executionNode),
      Instance.node.replace(instanceNode),
      Global.node.replace(tempGlobalLayer),
      offlineModels,
    ],
  ),
)

const withDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(dir.path)))

describe("SessionTaskControl", () => {
  it.live("status and cancellation never start cold descendant Locations", () =>
    withDir((dir) =>
      withDir((cold) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const instances = yield* Instance.Service
          const control = yield* SessionTaskControl.Service
          const database = yield* Database.Service
          const store = yield* SessionStore.Service
          const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
          const child = yield* sessions.create({ parentID: parent.id })
          yield* database.db
            .update(SessionTable)
            .set({ directory: AbsolutePath.make(cold) })
            .where(eq(SessionTable.id, child.id))
            .run()
          const stored = (yield* store.get(child.id))!
          expect(yield* instances.live!(stored)).toBe(false)
          expect((yield* control.status(parent.id)).shells).toEqual([])
          expect(yield* instances.live!(stored)).toBe(false)
          yield* control.cancelOne(parent.id, child.id)
          yield* control.stopAll(parent.id)
          expect(yield* instances.live!(stored)).toBe(false)
        }),
      ),
    ),
  )

  it.live("a removed descendant Location does not block status, cancel-one or stop-all for live shells", () =>
    withDir((dir) =>
      withDir((gone) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const instances = yield* Instance.Service
          const control = yield* SessionTaskControl.Service
          const database = yield* Database.Service
          const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
          const child = yield* sessions.create({ parentID: parent.id })
          const grandchild = yield* sessions.create({ parentID: child.id })
          const shell = yield* Shell.Service.pipe(instances.provide(parent))
          yield* database.db
            .update(SessionTable)
            .set({ directory: AbsolutePath.make(gone) })
            .where(eq(SessionTable.id, child.id))
            .run()
          yield* Effect.promise(() => fs.rm(gone, { recursive: true }))
          // Model a Location that was live/booting when checked but vanished before acquisition.
          calls.forceLive = gone
          const start = (sessionID: Session.ID) =>
            Effect.acquireRelease(
              shell.create({
                command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`,
                cwd: dir,
                timeout: 0,
                metadata: { sessionID },
              }),
              (info) => shell.stop(info.id, "killed").pipe(Effect.andThen(shell.wait(info.id)), Effect.orDie),
            )
          const own = yield* start(parent.id)
          const nested = yield* start(grandchild.id)
          expect((yield* control.status(parent.id)).shells.map((info) => info.id).sort()).toEqual(
            [own.id, nested.id].sort(),
          )
          expect((yield* control.cancelOne(parent.id, child.id)).stoppedShells).toEqual([nested.id])
          expect((yield* shell.wait(nested.id)).status).toBe("killed")
          expect((yield* control.stopAll(parent.id)).stoppedShells).toEqual([own.id])
          expect((yield* shell.wait(own.id)).status).toBe("killed")
        }),
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => (calls.forceLive = undefined)))),
  )

  it.live("a corrupt ancestry cycle terminates without making the caller its own descendant", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const control = yield* SessionTaskControl.Service
        const database = yield* Database.Service
        const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
        const child = yield* sessions.create({ parentID: parent.id })
        yield* database.db.update(SessionTable).set({ parent_id: child.id }).where(eq(SessionTable.id, parent.id)).run()
        expect((yield* control.status(parent.id)).shells).toEqual([])
        expect((yield* control.cancelOne(parent.id, parent.id)).owned).toBe(false)
        calls.interrupted.length = 0
        yield* control.cancelOne(parent.id, child.id)
        expect(calls.interrupted).toEqual([child.id])
      }),
    ),
  )

  for (const state of ["running", "completed", "untracked"] as const) {
    it.live(`stops ${state} descendants' shells without deleting output or touching unrelated sessions`, () =>
      withDir((dir) =>
        Effect.gen(function* () {
          calls.interruptResult = false
          calls.woken.length = 0
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const control = yield* SessionTaskControl.Service
          const instances = yield* Instance.Service
          const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(dir) }) })
          const child = yield* sessions.create({ parentID: parent.id })
          const grandchild = yield* sessions.create({ parentID: child.id })
          const unrelated = yield* sessions.create({ location: parent.location })
          const shell = yield* Shell.Service.pipe(instances.provide(parent))
          if (state !== "untracked") {
            yield* jobs.start({
              id: child.id,
              type: "subagent",
              recovery: {
                kind: "subagent",
                parentSessionID: parent.id,
                childSessionID: child.id,
                agent: "test",
                description: state,
              },
              run: state === "completed" ? Effect.succeed("done") : Effect.never,
            })
            yield* jobs.background(child.id)
            if (state === "completed") yield* jobs.wait({ id: child.id })
          }
          const start = (sessionID: Session.ID) =>
            Effect.acquireRelease(
              shell.create({
                command: `"${process.execPath}" -e "console.log('retained');setInterval(()=>{},1000)"`,
                cwd: dir,
                timeout: 0,
                metadata: { sessionID, background: true },
              }),
              (info) => shell.stop(info.id, "killed").pipe(Effect.andThen(shell.wait(info.id)), Effect.orDie),
            )
          const own = yield* start(parent.id)
          const first = yield* start(child.id)
          yield* ShellTool.reattach({ shell, jobs, sessions, sessionID: child.id, info: first })
          const second = yield* start(grandchild.id)
          const other = yield* start(unrelated.id)
          yield* shell.output(first.id).pipe(
            Effect.repeat({
              while: (result) => !result.output.includes("retained"),
              schedule: Schedule.spaced("5 millis"),
            }),
            Effect.timeout("10 seconds"),
          )
          const status = yield* control.status(parent.id)
          expect(status.active).toBe(false)
          expect(status.shells.map((info) => info.id).sort()).toEqual([own.id, first.id, second.id].sort())
          // Stopping a response is not an explicit cancellation of its background work.
          yield* control.stopResponse(parent.id)
          expect((yield* shell.get(first.id)).status).toBe("running")
          expect(yield* control.cancelOne(parent.id, unrelated.id)).toEqual({
            owned: false,
            cancelled: [],
            stoppedShells: [],
          })
          expect((yield* shell.get(other.id)).status).toBe("running")
          expect((yield* control.cancelOne(parent.id, parent.id)).owned).toBe(false)
          // Any ancestor may directly target a grandchild, even without a tracked job.
          const direct = yield* control.cancelOne(parent.id, grandchild.id)
          expect(direct.owned).toBe(true)
          expect(direct.stoppedShells).toEqual([second.id])
          yield* shell.wait(second.id)
          const nested = yield* start(grandchild.id)
          const result = yield* control.cancelOne(parent.id, child.id)
          expect(result.owned).toBe(true)
          expect(result.cancelled).toEqual(state === "running" ? [child.id] : [])
          expect(result.stoppedShells.toSorted()).toEqual([first.id, nested.id].sort())
          yield* shell.wait(nested.id)
          expect((yield* shell.wait(first.id)).status).toBe("killed")
          expect(yield* jobs.get(first.id)).toMatchObject({ status: "cancelled", metadata: { suppressed: true } })
          const notes = yield* sessions.inbox(child.id)
          expect(notes).toHaveLength(1)
          expect(notes[0]).toMatchObject({
            type: "synthetic",
            payload: { text: expect.stringContaining("No completion notification will arrive; do not wait for one.") },
          })
          expect(calls.woken).toEqual([])
          expect((yield* shell.output(first.id)).output).toContain("retained")
          expect(yield* Effect.promise(() => Bun.file(first.file).exists())).toBe(true)
          expect((yield* shell.get(own.id)).status).toBe("running")
          expect((yield* shell.get(other.id)).status).toBe("running")
          if (state === "running")
            expect(yield* jobs.get(child.id)).toMatchObject({ status: "cancelled", metadata: { suppressed: true } })
          if (state === "completed") expect((yield* jobs.get(child.id))?.status).toBe("completed")
          const remaining = yield* start(grandchild.id)
          const all = yield* control.stopAll(parent.id)
          expect(all.interrupted).toBe(false)
          expect(all.cancelled).toEqual([])
          expect(all.stoppedShells.toSorted()).toEqual([own.id, remaining.id].sort())
          yield* shell.wait(own.id)
          yield* shell.wait(remaining.id)
          expect((yield* shell.get(other.id)).status).toBe("running")
          expect((yield* control.stopAll(parent.id)).stoppedShells).toEqual([])
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => (calls.interruptResult = true)))),
    )
  }

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
          shells: [],
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
        // A child's settled hook must already see the suppressing cancel when its interrupt lands.
        const statusAtInterrupt: Record<string, unknown> = {}
        calls.onInterrupt = (id) =>
          jobs.get(id).pipe(Effect.map((job) => void (statusAtInterrupt[id] = job?.metadata?.suppressed)))
        const result = yield* control
          .stopAll(parent.id)
          .pipe(Effect.ensuring(Effect.sync(() => (calls.onInterrupt = undefined))))
        expect(result.interrupted).toBe(true)
        expect(result.cancelled).toEqual([grandchild.id, child.id])
        expect(calls.interrupted).toEqual([grandchild.id, child.id, parent.id])
        expect(statusAtInterrupt).toEqual({ [grandchild.id]: true, [child.id]: true, [parent.id]: undefined })
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
