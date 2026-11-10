export * as SubagentJob from "./subagent-job.js"

import { Context, Effect, Layer, Scope } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { Job } from "../job.js"
import { Session } from "../session.js"
import type { SessionMessage } from "./message.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

export type StartOptions = {
  readonly admissionID?: SessionMessage.ID
  readonly admitOnly?: boolean
  readonly foreground?: Session.ID
  readonly preserveBackground?: boolean
  /** Admission owns the generation before waking execution; do not observe the old idle yet. */
  readonly ready?: Effect.Effect<void>
}

export interface Interface {
  start: (recovery: Recovery, options?: StartOptions) => Effect.Effect<Job.Acquired>
  background: (recovery: Recovery, handle: Job.Acquired) => Effect.Effect<void>
  notify: (recovery: Recovery, handle: Job.Acquired) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentJob") {}

const make: Effect.Effect<Interface, never, Session.Service | Job.Service | Scope.Scope> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  // Jobs and their completion observers outlive the plugin that launched them.
  // Fork with the global context too, rather than retaining the caller's location.
  const context = yield* Effect.context<never>()
  // One observer per job generation, including continuations of the same child.
  const lastText = Effect.fnUntraced(function* (
    childSessionID: Recovery["childSessionID"],
    admissionID?: SessionMessage.ID,
  ) {
    const pending = yield* sessions.inbox(childSessionID)
    if (pending.some((item) => item.type === "user"))
      return yield* Effect.fail(new Error("Subagent continuation remains undelivered"))
    if (admissionID !== undefined) {
      const after = yield* sessions.messages({
        sessionID: childSessionID,
        type: "assistant",
        order: "asc",
        limit: 1,
        cursor: { id: admissionID, direction: "next" },
      })
      if (after.length === 0) return yield* Effect.fail(new Error("Subagent continuation has no completed response"))
    }
    const assistant = (yield* sessions.messages({
      sessionID: childSessionID,
      type: "assistant",
      order: "desc",
      limit: 1,
    })).find((message) => message.type === "assistant")
    if (assistant?.type === "assistant" && assistant.interruption !== undefined) return yield* Effect.interrupt
    if (assistant?.type === "assistant" && assistant.error !== undefined)
      return yield* Effect.fail(new Error("Subagent response failed"))
    if ((assistant && assistant.time.completed === undefined) || (admissionID !== undefined && !assistant))
      return yield* Effect.fail(new Error("Subagent continuation has no completed response"))
    return SubagentCompletion.text(assistant)
  })

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, handle: Job.Acquired) {
    if (!(yield* handle.observe)) return
    yield* Effect.gen(function* () {
      const info = yield* handle.wait
      if (yield* handle.claimBackground)
        yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery })
    }).pipe(
      // The global context drops the caller's span annotations; delivery is the parent session's work.
      Effect.annotateSpans("session.id", recovery.parentSessionID),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.setContext(context),
    )
  })

  return Service.of({
    start: (recovery: Recovery, options) =>
      jobs
        .acquire(
          {
            id: recovery.childSessionID,
            type: "subagent",
            title: recovery.description,
            metadata: {},
            recovery,
            preserveBackground: options?.preserveBackground,
            run: Effect.gen(function* () {
              if (options?.ready) yield* options.ready
              if (options?.admitOnly !== false) yield* sessions.resume(recovery.childSessionID)
              yield* sessions.wait(recovery.childSessionID)
              return yield* lastText(recovery.childSessionID, options?.admissionID)
            }),
          },
          options?.foreground,
        )
        .pipe(Effect.setContext(context)),
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery, handle) {
      const info = yield* handle.background
      if (info) yield* notify(recovery, handle)
    }),
    notify,
  })
})

export const layer = Layer.effect(Service, make)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [Session.node, Job.node],
})
