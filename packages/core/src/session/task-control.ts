export * as SessionTaskControl from "./task-control.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionTask } from "@opencode/schema/session-task"
import { Job } from "../job.js"
import { SessionExecution } from "./execution.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { NotFoundError } from "./error.js"

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
 * cancels the owned job tree and permanently suppresses its notifications;
 * "cancel one" does the same for a single owned child, refusing one that isn't owned.
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

    const status: Interface["status"] = Effect.fn("SessionTaskControl.status")(function* (sessionID) {
      yield* get(sessionID)
      const owned = yield* children(sessionID)
      return Status.make({
        paused: yield* jobs.paused(sessionID),
        active: yield* execution.isActive(sessionID),
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
      const interrupted = yield* execution.interrupt(sessionID, { reason: "user" })
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

    // Depth first: a child's own descendants are suppressed before its notification could fire.
    const cancelEntry = (entry: Effect.Success<ReturnType<typeof children>>[number]): Effect.Effect<Array<SessionSchema.ID>> =>
      Effect.gen(function* () {
        const cancelled = yield* cancelTree(entry.recovery.childSessionID)
        if (entry.job.status !== "running") return cancelled
        yield* execution.interrupt(entry.recovery.childSessionID, { reason: "user" })
        yield* jobs.cancel(entry.job.id, { suppress: true })
        cancelled.push(entry.recovery.childSessionID)
        return cancelled
      })

    const cancelTree = (parentSessionID: SessionSchema.ID): Effect.Effect<Array<SessionSchema.ID>> =>
      Effect.gen(function* () {
        const owned = yield* children(parentSessionID)
        const cancelled: Array<SessionSchema.ID> = []
        for (const entry of owned) cancelled.push(...(yield* cancelEntry(entry)))
        return cancelled
      })

    const stopAll: Interface["stopAll"] = Effect.fn("SessionTaskControl.stopAll")(function* (sessionID) {
      yield* get(sessionID)
      const cancelled = yield* cancelTree(sessionID)
      const interrupted = yield* execution.interrupt(sessionID, { reason: "user" })
      return StopAllResult.make({ interrupted, cancelled })
    })

    const cancelOne: Interface["cancelOne"] = Effect.fn("SessionTaskControl.cancelOne")(
      function* (parentSessionID, childSessionID) {
        yield* get(parentSessionID)
        const owned = yield* children(parentSessionID)
        const entry = owned.find((entry) => entry.recovery.childSessionID === childSessionID)
        if (!entry) return CancelOneResult.make({ owned: false, cancelled: [] })
        const cancelled = yield* cancelEntry(entry)
        return CancelOneResult.make({ owned: true, cancelled })
      },
    )

    return Service.of({ status, stopResponse, resume, stopAll, cancelOne })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Job.node, SessionExecution.node, SessionStore.node],
})
