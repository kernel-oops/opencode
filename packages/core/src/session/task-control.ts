export * as SessionTaskControl from "./task-control.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionTask } from "@opencode/schema/session-task"
import { Job } from "../job.js"
import { SessionExecution } from "./execution.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { NotFoundError } from "./error.js"
import { Instance } from "../instance/service.js"
import { Shell } from "../shell.js"

export const Status = SessionTask.Status
export type Status = typeof Status.Type

export const StopResponseResult = SessionTask.StopResponseResult
export type StopResponseResult = typeof StopResponseResult.Type

export const StopAllResult = SessionTask.StopAllResult
export type StopAllResult = typeof StopAllResult.Type

export const ResumeResult = SessionTask.ResumeResult
export type ResumeResult = typeof ResumeResult.Type

export const CancelOneResult = SessionTask.CancelOneResult
export type CancelOneResult = typeof CancelOneResult.Type

/**
 * Separate response and work controls for a controller Session that owns
 * background subagents. "Stop response" pauses automatic completion delivery
 * and interrupts the current response while accepted background work survives;
 * "resume" releases that pause and rings the Session doorbell; "stop all" also
 * cancels persisted descendants, suppresses their running jobs' notifications
 * and stops their shells without deleting output. "Cancel one" does the same
 * for a persisted descendant subtree, refusing Sessions outside the tree.
 */
export interface Interface {
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<Status, NotFoundError>
  readonly stopResponse: (sessionID: SessionSchema.ID) => Effect.Effect<StopResponseResult, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<ResumeResult, NotFoundError>
  readonly stopAll: (sessionID: SessionSchema.ID) => Effect.Effect<StopAllResult, NotFoundError>
  readonly cancelOne: (
    parentSessionID: SessionSchema.ID,
    childSessionID: SessionSchema.ID,
  ) => Effect.Effect<CancelOneResult, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTaskControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service

    const get = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })

    const children = (parentSessionID: SessionSchema.ID) =>
      jobs.list.pipe(
        Effect.map((all) =>
          all.flatMap((job) =>
            job.recovery?.kind === "subagent" && job.recovery.parentSessionID === parentSessionID
              ? [{ job, recovery: job.recovery }]
              : [],
          ),
        ),
      )

    const tree = (sessionID: SessionSchema.ID): Effect.Effect<Array<SessionSchema.Info>> =>
      Effect.gen(function* () {
        const descendants: Array<SessionSchema.Info> = []
        for (const child of yield* store.list({ parentID: sessionID })) {
          descendants.push(...(yield* tree(child.id)), child)
        }
        return descendants
      })

    const shells = Effect.fnUntraced(function* (sessions: Array<SessionSchema.Info>) {
      const found: Array<{ shell: Shell.Interface; info: typeof SessionTask.BackgroundShell.Type }> = []
      // Descendants may have different Locations; inspect each persisted placement once.
      const locations = new Set<string>()
      for (const session of sessions) {
        const key = JSON.stringify(session.location)
        if (locations.has(key)) continue
        locations.add(key)
        const shell = yield* Shell.Service.pipe(instances.provide(session), Effect.orDie)
        for (const info of yield* shell.list()) {
          const sessionID = sessions.find((session) => session.id === info.metadata.sessionID)?.id
          if (!sessionID) continue
          found.push({ shell, info: { id: info.id, sessionID, command: info.command } })
        }
      }
      return found
    })

    const stopShells = Effect.fnUntraced(function* (entries: Effect.Success<ReturnType<typeof shells>>) {
      const all = yield* jobs.list
      return yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const job = all.find((job) => job.recovery?.kind === "shell" && job.recovery.shellID === entry.info.id)
          if (job?.status === "running") yield* jobs.cancel(job.id, { suppress: true })
          yield* entry.shell.stop(entry.info.id, "killed").pipe(Effect.orDie)
          return entry.info.id
        }),
      )
    })

    const status: Interface["status"] = Effect.fn("SessionTaskControl.status")(function* (sessionID) {
      const session = yield* get(sessionID)
      const owned = yield* children(sessionID)
      return Status.make({
        paused: yield* jobs.paused(sessionID),
        active: yield* execution.isActive(sessionID),
        shells: (yield* shells([session, ...(yield* tree(sessionID))])).map((entry) => entry.info),
        background: owned.map(({ job, recovery }) =>
          SessionTask.Background.make({
            sessionID: recovery.childSessionID,
            agent: recovery.agent,
            description: recovery.description,
            status: job.status,
          }),
        ),
      })
    })

    const stopResponse: Interface["stopResponse"] = Effect.fn("SessionTaskControl.stopResponse")(function* (sessionID) {
      yield* get(sessionID)
      // Pause before interrupting so a completion racing the interruption is retained, not delivered.
      yield* jobs.pause(sessionID)
      const interrupted = yield* execution.interrupt(sessionID)
      return StopResponseResult.make({ interrupted, paused: true })
    })

    const resume: Interface["resume"] = Effect.fn("SessionTaskControl.resume")(function* (sessionID) {
      yield* get(sessionID)
      const paused = yield* jobs.paused(sessionID)
      yield* jobs.unpause(sessionID)
      // The doorbell drains retained completions already admitted to the inbox.
      yield* execution.wake(sessionID)
      return ResumeResult.make({ resumed: paused })
    })

    const cancel = Effect.fnUntraced(function* (sessions: Array<SessionSchema.Info>) {
      const all = yield* jobs.list
      const runningShells = yield* shells(sessions)
      // Silence shell completions before interrupting their owner could settle foreground calls.
      const stoppedShells = yield* stopShells(runningShells)
      const cancelled: Array<SessionSchema.ID> = []
      // Depth first, with suppression before interruption can settle a job's notification.
      for (const session of sessions) {
        const job = all.find((job) => job.recovery?.kind === "subagent" && job.recovery.childSessionID === session.id)
        if (job?.status === "running") yield* jobs.cancel(job.id, { suppress: true })
        const interrupted = yield* execution.interrupt(session.id)
        if (job?.status === "running" || interrupted) cancelled.push(session.id)
      }
      return { cancelled, stoppedShells }
    })

    const stopAll: Interface["stopAll"] = Effect.fn("SessionTaskControl.stopAll")(function* (sessionID) {
      const session = yield* get(sessionID)
      const result = yield* cancel(yield* tree(sessionID))
      const stoppedShells = [...result.stoppedShells, ...(yield* stopShells(yield* shells([session])))]
      const interrupted = yield* execution.interrupt(sessionID)
      return StopAllResult.make({ interrupted, cancelled: result.cancelled, stoppedShells })
    })

    const cancelOne: Interface["cancelOne"] = Effect.fn("SessionTaskControl.cancelOne")(
      function* (parentSessionID, childSessionID) {
        yield* get(parentSessionID)
        const owned = yield* tree(parentSessionID)
        const child = owned.find((session) => session.id === childSessionID)
        if (!child) return CancelOneResult.make({ owned: false, cancelled: [], stoppedShells: [] })
        const result = yield* cancel([...(yield* tree(childSessionID)), child])
        return CancelOneResult.make({ owned: true, ...result })
      },
    )

    return Service.of({ status, stopResponse, resume, stopAll, cancelOne })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Job.node, SessionExecution.node, SessionStore.node, Instance.node],
})
