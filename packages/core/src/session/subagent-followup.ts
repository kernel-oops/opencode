export * as SubagentFollowup from "./subagent-followup.js"

import { Effect, Scope } from "effect"
import { Job } from "../job.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionStore } from "./store.js"
import { SubagentCompletion } from "./subagent-completion.js"
import { NotFoundError, SyntheticConflictError } from "./error.js"
import type { SessionSchema } from "./schema.js"

/** Observe orphaned child turns at execution start, irrespective of their wake source. */
export const make = Effect.fn("SubagentFollowup.make")(function* (execution: {
  awaitIdle: (id: SessionSchema.ID) => Effect.Effect<void>
  wake: (id: SessionSchema.ID) => Effect.Effect<void>
}) {
  const store = yield* SessionStore.Service
  const jobs = yield* Job.Service
  const inbox = yield* SessionInbox.Service
  const scope = yield* Scope.Scope
  return Effect.fn("SubagentFollowup.started")(function* (sessionID: SessionSchema.ID) {
    const session = yield* store.get(sessionID)
    if (!session?.parentID || !session.agent || (yield* jobs.get(sessionID))?.status === "running") return
    const [previous] = yield* store.messages({ sessionID, type: "assistant", order: "desc", limit: 1 }).pipe(Effect.orDie)
    // Placement/maintenance before the first response is not a finished subagent turn.
    if (!previous) return
    const recovery = {
      kind: "subagent" as const,
      parentSessionID: session.parentID,
      childSessionID: sessionID,
      agent: session.agent,
      description: `Follow-up completion: ${session.title}`,
    }
    const handle = yield* jobs.acquire({
      id: sessionID,
      type: "subagent",
      title: recovery.description,
      recovery,
      metadata: { followup: true },
      onlyIfIdle: true,
      run: Effect.gen(function* () {
        yield* execution.awaitIdle(sessionID)
        const [message] = yield* store.messages({ sessionID, type: "assistant", order: "desc", limit: 1 })
        if (message?.id === previous?.id) return ""
        if ((yield* inbox.list(sessionID)).some((item) => item.type === "user"))
          return yield* Effect.fail(new Error("Subagent continuation remains undelivered"))
        if (message?.type === "assistant" && message.interruption !== undefined) return yield* Effect.interrupt
        if (message?.type === "assistant" && message.error !== undefined)
          return yield* Effect.fail(new Error("Subagent response failed"))
        if (message?.type !== "assistant" || message.time.completed === undefined)
          return yield* Effect.fail(new Error("Subagent follow-up has no completed response"))
        return SubagentCompletion.text(message)
      }),
    })
    if (!handle.created) return
    if (!(yield* handle.observe)) return
    yield* Effect.gen(function* () {
      const info = yield* handle.wait
      if (!(yield* handle.claimBackground)) return
      const [latest] = yield* store.messages({ sessionID, type: "assistant", order: "desc", limit: 1 }).pipe(Effect.orDie)
      // Maintenance-only busy periods have no new reply to forward.
      if (latest?.id === previous?.id) {
        if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
        return
      }
      yield* SubagentCompletion.deliver(
        {
          synthetic: (input) =>
            Effect.gen(function* () {
              const parent = yield* store.get(input.sessionID)
              if (!parent) return yield* new NotFoundError({ sessionID: input.sessionID })
              const admitted = yield* inbox
                .admit({
                  id: input.id ?? SessionMessage.ID.create(),
                  sessionID: input.sessionID,
                  item: {
                    type: "synthetic",
                    delivery: "steer",
                    payload: { text: input.text, description: input.description, metadata: input.metadata },
                  },
                })
                .pipe(
                  Effect.catchTag(
                    "SessionInbox.LifecycleConflict",
                    () => new SyntheticConflictError({ sessionID: input.sessionID, inputID: input.id! }),
                  ),
                )
              if (input.resume !== false && !parent.revert) yield* execution.wake(input.sessionID)
              return admitted
            }),
        },
        jobs,
        { ...info, recovery },
      ).pipe(Effect.orDie)
    }).pipe(Effect.forkIn(scope, { startImmediately: true }))
  })
})
