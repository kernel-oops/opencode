export * as Job from "./job.js"

import { asc, eq, or } from "drizzle-orm"
import {
  Array,
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Job as JobSchema } from "@opencode/schema/job"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { JobList } from "./job/list.js"
import { type Recovery, RecoverySchema } from "./job/recovery.js"
import { JobTable } from "./job/sql.js"
import { KV } from "./kv.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"

export type { Recovery }

/** A session-wide background request releases the outer blocker; its nested waits keep their own deadlines. */
export const BlockingParent = Context.Reference<string | undefined>("@opencode/Job/BlockingParent", {
  defaultValue: () => undefined,
})

const Background = Schema.Struct({
  id: Schema.String,
  notificationID: SessionMessage.ID,
  recovery: RecoverySchema,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})

export type Background = typeof Background.Type
export type Status = Background["status"]

export type SubagentReportState =
  | {
      readonly mode: "background"
      readonly notificationID: SessionMessage.ID
      readonly recovery: Extract<Recovery, { kind: "subagent" }>
      readonly startedAt: number
    }
  | { readonly mode: "none" }
  /** A task_cancel/stop-all cancellation: release the child without any report to the parent. */
  | { readonly mode: "suppressed" }

export type SubagentOutboxReport = {
  readonly notificationID: SessionMessage.ID
  readonly recovery: Extract<Recovery, { kind: "subagent" }>
  readonly status: Exclude<Status, "running">
  readonly output?: string
  readonly error?: string
  readonly startedAt?: number
}

const decodeBackground = Schema.decodeUnknownResult(Background)
const COMPLETED_LIMIT = 25
const pausePrefix = "job.paused/"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  notificationID?: SessionMessage.ID
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  scope: Scope.Closeable
  generation: number
  blockingSessions: Map<SessionSchema.ID, number>
  isBackgrounded: boolean
  settling: boolean
  consumed: boolean
  reported: boolean
  cancelledByCaller: boolean
  suppressed?: boolean
  recovery?: Recovery
  cancel?: Effect.Effect<void>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  generations: Ref.Ref<number>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  cancel?: Effect.Effect<void>
  scope?: Scope.Closeable
  generation?: Scope.Closeable
  listed?: JobSchema.Info
}

type BackgroundResult = {
  info?: Info
  backgrounded?: Deferred.Deferred<Info>
}

type StartResult = { info: Info } | { info: Info; job: Active }

type BlockWait = {
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  generation: Scope.Closeable
}

type BlockStart =
  | { type: "missing" }
  | { type: "finished"; info: Info; generation: Scope.Closeable }
  | { type: "backgrounded"; info: Info }
  | { type: "wait"; wait: BlockWait }

export type StartInput = {
  id: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  recovery?: Recovery
  notificationID?: SessionMessage.ID
  background?: boolean
  run: Effect.Effect<string, unknown>
  // Runs when the job is cancelled (`cancel`, `cancelSession`), before its work is interrupted. Teardown, such as
  // a server shutdown, interrupts the work without it.
  cancel?: Effect.Effect<void>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export type BlockInput = {
  id: string
  sessionID: SessionSchema.ID
}

export type BlockResult = { type: "finished"; info: Info } | { type: "backgrounded"; info: Info }

export type BackgroundAllInput = {
  sessionID: SessionSchema.ID
  type?: string
}

export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly block: (input: BlockInput) => Effect.Effect<BlockResult | undefined>
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  readonly backgroundAll: (input: BackgroundAllInput) => Effect.Effect<Info[]>
  readonly cancel: (id: string, options?: CancelOptions) => Effect.Effect<Info | undefined>
  readonly cancelSession: (sessionID: SessionSchema.ID) => Effect.Effect<Info[]>
  readonly pendingBackground: Effect.Effect<readonly Background[]>
  readonly runningBackground: Effect.Effect<readonly Recovery[]>
  readonly backgroundJobs: Effect.Effect<readonly JobList.Item[]>
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
  /** Whether an explicit caller cancellation stopped this job (not shutdown teardown). */
  readonly isCancelled: (id: string) => Effect.Effect<boolean>
  readonly currentGeneration: (
    id: string,
  ) => Effect.Effect<{ readonly generation: number; readonly running: boolean } | undefined>
  readonly prepareSubagentReport: (id: string, boundGeneration?: number) => Effect.Effect<SubagentReportState>
  readonly recordSubagentReport: (report: SubagentOutboxReport) => Effect.Effect<void>
  readonly deleteBackgroundRow: (notificationID: SessionMessage.ID) => Effect.Effect<void>
  /** Snapshots every process-local job with its recovery record. */
  readonly list: Effect.Effect<readonly Listed[]>
  /** Durably pauses completion delivery wake-ups for a parent Session until `unpause`. */
  readonly pause: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly unpause: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly paused: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export type CancelOptions = {
  /** Drop the completion report and durable marker so the parent is never told about this cancellation. */
  suppress?: boolean
}

export type Listed = Info & { recovery?: Recovery }

export class Service extends Context.Service<Service, Interface>()("@opencode/Job") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function ownerSessionID(recovery: Recovery): SessionSchema.ID {
  return recovery.kind === "subagent" ? recovery.parentSessionID : recovery.sessionID
}

function recoveryTitle(job: Active, recovery: Recovery): string | null {
  if (job.info.title !== undefined) return job.info.title
  if (recovery.kind === "shell") return recovery.command
  if (recovery.kind === "subagent") return recovery.description
  if (recovery.kind === "codemode") return "Code Mode script"
  return recovery.path
}

function matchesSession(job: Active, sessionID: SessionSchema.ID) {
  if (job.info.metadata?.sessionID === sessionID) return true
  if (job.blockingSessions.has(sessionID)) return true
  if (!job.recovery) return false
  if (job.recovery.kind === "subagent")
    return job.recovery.parentSessionID === sessionID || job.recovery.childSessionID === sessionID
  return job.recovery.sessionID === sessionID
}

function errorText(cause: Cause.Cause<unknown>) {
  const render = (error: Error): string => {
    const message = error.message || error.name || "Unknown error"
    if (!(error.cause instanceof Error)) return message
    const detail = render(error.cause)
    return detail === message || detail.startsWith(`${message}\n`) ? detail : `${message}\nCaused by: ${detail}`
  }
  return Cause.prettyErrors(cause).map(render).join("\n") || "Unknown error"
}

function incrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  return new Map(input).set(sessionID, (input.get(sessionID) ?? 0) + 1)
}

function decrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  const count = input.get(sessionID)
  if (count === undefined) return input
  const next = new Map(input)
  if (count <= 1) next.delete(sessionID)
  else next.set(sessionID, count - 1)
  return next
}

/**
 * Makes one scoped, process-local registry backed by the durable SQLite `job` table for
 * backgrounded work until its completion notification is admitted.
 */
export const make = Effect.gen(function* () {
  const kv = yield* KV.Service
  const db = (yield* Database.Service).db
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    generations: yield* Ref.make(0),
    scope: yield* Scope.Scope,
  }
  const bus = Option.getOrUndefined(yield* Effect.serviceOption(Bus.Service))

  // Clients follow listed jobs through this instead of polling the list.
  const updated = (listed: JobSchema.Info | undefined) =>
    bus && listed ? bus.publish(JobSchema.Event.Updated, { info: listed }).pipe(Effect.asVoid) : Effect.void
  const listed = (info: Info, recovery: Recovery | undefined) => (recovery ? JobList.item(info, recovery) : undefined)

  const consume = (id: string, generation: Scope.Closeable) =>
    SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(id)
      if (!job || job.scope !== generation || job.info.status === "running" || job.consumed) return jobs
      const next = new Map(jobs)
      // Order history by first consumption, not by start time or subsequent reads.
      next.delete(id)
      next.set(id, { ...job, consumed: true })
      const completed = [...next].filter(([, job]) => job.consumed && !job.info.notificationID)
      for (const [id] of completed.slice(0, -COMPLETED_LIMIT)) next.delete(id)
      return next
    })

  const persistBackground = Effect.fnUntraced(function* (job: Active) {
    if (!job.recovery || !job.info.notificationID) return
    const now = yield* Clock.currentTimeMillis
    const values = {
      notification_id: job.info.notificationID,
      id: job.info.id,
      session_id: ownerSessionID(job.recovery),
      child_session_id: job.recovery.kind === "subagent" ? job.recovery.childSessionID : null,
      kind: job.recovery.kind,
      title: recoveryTitle(job, job.recovery),
      status: job.info.status,
      output: job.info.output ?? null,
      error: job.info.error ?? null,
      recovery: job.recovery,
      time_created: job.info.started_at,
      time_updated: now,
    }
    yield* db
      .insert(JobTable)
      .values(values)
      .onConflictDoUpdate({
        target: JobTable.notification_id,
        set: {
          status: values.status,
          output: values.output,
          error: values.error,
          recovery: values.recovery,
          time_updated: now,
        },
      })
      .run()
      .pipe(Effect.orDie)
  })

  const settle = Effect.fnUntraced(function* (id: string, active: Active, exit: Exit.Exit<string, unknown>) {
    const completed_at = yield* Clock.currentTimeMillis
    const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
      ? "completed"
      : Cause.hasInterruptsOnly(exit.cause)
        ? "cancelled"
        : "error"
    const output = Exit.isSuccess(exit) ? exit.value : undefined
    const error = Exit.isFailure(exit) ? errorText(exit.cause) : undefined
    const terminal = (job: Active): Active => ({
      ...job,
      blockingSessions: new Map<SessionSchema.ID, number>(),
      info: {
        ...job.info,
        status,
        completed_at,
        ...(output !== undefined ? { output } : {}),
        ...(error !== undefined ? { error } : {}),
      },
    })
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // Teardown (this registry closing) is not a terminal outcome: leave the job and its durable row running for
        // the next server. The scope's own finalizer interrupts its observers. A cancel has already settled the job
        // as cancelled before interrupting its work.
        if (status === "cancelled" && active.scope.state._tag === "Closed") return [{}, jobs]
        // A newer generation may already have replaced this one in the registry. Its waiters still
        // need their deferred resolved and its scope closed, so never drop the settlement on the floor.
        if (!job || job.scope !== active.scope) {
          return [{ info: snapshot(terminal(active)), done: active.done, scope: active.scope }, jobs]
        }
        if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
        const next = terminal(job)
        if (job.consumed) {
          const remaining = new Map(jobs)
          remaining.delete(id)
          return [{ info: snapshot(next), done: job.done, scope: job.scope }, remaining]
        }
        // A consumed job's notification row is gone; persisting here would resurrect it.
        // A settling generation's row belongs to the settlement commit; leaving it alone keeps
        // conflict-retained markers and late settlements consistent.
        if (status !== "cancelled" && !job.settling && !job.consumed) yield* persistBackground(next)
        return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.done && result.info) yield* updated(listed(result.info, active.recovery))
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const get: Interface["get"] = Effect.fn("Job.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return undefined
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fnUntraced(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const backgrounded = yield* Deferred.make<Info>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [StartResult, Map<string, Active>]> {
            const existing = jobs.get(input.id)
            // A settling generation is already reporting; new work starts a fresh generation.
            if (existing?.info.status === "running" && !existing.settling) {
              return [{ info: snapshot(existing) }, jobs]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            // Closing the registry interrupts the work without settling it; interrupt its observers too.
            yield* Scope.addFinalizer(scope, Deferred.interrupt(done))
            const notificationID =
              input.notificationID ?? (input.background && input.recovery ? SessionMessage.ID.create() : undefined)
            const job: Active = {
              info: {
                id: input.id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
                ...(notificationID ? { notificationID } : {}),
              },
              done,
              backgrounded,
              scope,
              generation: yield* Ref.updateAndGet(state.generations, (generation) => generation + 1),
              blockingSessions: new Map<SessionSchema.ID, number>(),
              isBackgrounded: input.background === true,
              settling: false,
              consumed: false,
              reported: false,
              cancelledByCaller: false,
              recovery: input.recovery,
              cancel: input.cancel,
            }
            // Background work becomes durable before its run is forked, so no drain can observe
            // an unmarked period.
            if (job.isBackgrounded) yield* persistBackground(job)
            return [{ info: snapshot(job), job }, new Map(jobs).set(input.id, job)]
          }),
        )
        if ("job" in result && result.job.isBackgrounded) yield* updated(listed(result.info, result.job.recovery))
        if ("job" in result)
          yield* restore(input.run).pipe(
            Effect.exit,
            Effect.flatMap((exit) => settle(input.id, result.job, exit)),
            Effect.asVoid,
            Effect.forkIn(result.job.scope, { startImmediately: true }),
          )
        return result.info
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("Job.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    return yield* Effect.gen(function* () {
      if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      return { info: snapshot(job), timedOut: true }
    }).pipe(
      // Recoverable wait -> background is a supported handoff, even after failure.
      Effect.tap((result) =>
        result.info?.status === "running" || job.recovery ? Effect.void : consume(input.id, job.scope),
      ),
    )
  })

  const removeBlock = Effect.fnUntraced(function* (input: BlockInput) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(input.id)
      if (!job || job.info.status !== "running" || job.isBackgrounded) return jobs
      return new Map(jobs).set(input.id, {
        ...job,
        blockingSessions: decrementSession(job.blockingSessions, input.sessionID),
      })
    })
  })

  const block: Interface["block"] = Effect.fnUntraced(function* (input) {
    const parent = yield* BlockingParent
    const tracksSession = parent === undefined || parent === input.id
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [BlockStart, Map<string, Active>] => {
      const job = jobs.get(input.id)
      if (!job) return [{ type: "missing" }, jobs]
      if (job.info.status !== "running") return [{ type: "finished", info: snapshot(job), generation: job.scope }, jobs]
      if (job.isBackgrounded) return [{ type: "backgrounded", info: snapshot(job) }, jobs]
      return [
        { type: "wait", wait: { done: job.done, backgrounded: job.backgrounded, generation: job.scope } },
        tracksSession
          ? new Map(jobs).set(input.id, {
              ...job,
              blockingSessions: incrementSession(job.blockingSessions, input.sessionID),
            })
          : jobs,
      ]
    })
    if (result.type === "missing") return undefined
    if (result.type === "finished") {
      yield* consume(input.id, result.generation)
      return { type: "finished", info: result.info }
    }
    if (result.type === "backgrounded") return { type: "backgrounded", info: result.info }
    return yield* Effect.raceFirst(
      Deferred.await(result.wait.done).pipe(Effect.map((info) => ({ type: "finished" as const, info }))),
      Deferred.await(result.wait.backgrounded).pipe(Effect.map((info) => ({ type: "backgrounded" as const, info }))),
    ).pipe(
      Effect.tap((outcome) => (outcome.type === "finished" ? consume(input.id, result.wait.generation) : Effect.void)),
      Effect.ensuring(tracksSession ? removeBlock(input) : Effect.void),
    )
  })

  const markBackground = Effect.fnUntraced(function* (job: Active) {
    const next = {
      ...job,
      isBackgrounded: true,
      blockingSessions: new Map<SessionSchema.ID, number>(),
      info: {
        ...job.info,
        ...(job.recovery ? { notificationID: job.info.notificationID ?? SessionMessage.ID.create() } : {}),
      },
    }
    yield* persistBackground(next)
    return next
  })

  const background: Interface["background"] = Effect.fn("Job.background")(function* (id) {
    let moved: JobSchema.Info | undefined
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [BackgroundResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // Recoverable work may finish before the caller backgrounds it.
        if (!job || (job.info.status !== "running" && !job.recovery)) return [{}, jobs]
        if (job.isBackgrounded) return [{ info: snapshot(job) }, jobs]
        const next = yield* markBackground(job)
        moved = listed(next.info, next.recovery)
        return [{ info: snapshot(next), backgrounded: job.backgrounded }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.backgrounded) yield* Deferred.succeed(result.backgrounded, result.info)
    yield* updated(moved)
    return result.info
  })

  const backgroundAll: Interface["backgroundAll"] = Effect.fn("Job.backgroundAll")(function* (input) {
    const moved: (JobSchema.Info | undefined)[] = []
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<
        readonly [Required<BackgroundResult>[], Map<string, Active>]
      > {
        const results: Required<BackgroundResult>[] = []
        const next = new Map(jobs)
        for (const [id, job] of jobs) {
          if (job.info.status !== "running") continue
          if (job.isBackgrounded) continue
          if (input.type !== undefined && job.info.type !== input.type) continue
          if (!job.blockingSessions.has(input.sessionID)) continue
          const updated = yield* markBackground(job)
          results.push({ info: snapshot(updated), backgrounded: job.backgrounded })
          moved.push(listed(updated.info, updated.recovery))
          next.set(id, updated)
        }
        return [results, next]
      }),
    )
    yield* Effect.forEach(result, (item) => Deferred.succeed(item.backgrounded, item.info), { discard: true })
    yield* Effect.forEach(moved, updated, { discard: true })
    return result.map((item) => item.info)
  })

  const cancelInternal = Effect.fnUntraced(function* (id: string, persist = true, options?: CancelOptions) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job), generation: job.scope }, jobs]
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          cancelledByCaller: persist,
          ...(options?.suppress ? { suppressed: true } : {}),
          info: {
            ...job.info,
            status: "cancelled" as const,
            completed_at,
            ...(options?.suppress ? { metadata: { ...job.info.metadata, suppressed: true } } : {}),
          },
        }
        // Settling work owns its outbox row: the settlement commit writes or deletes it.
        // A suppressed cancellation leaves no durable notification for restart recovery to deliver.
        if (options?.suppress && job.info.notificationID) {
          if (!job.settling)
            yield* db
              .delete(JobTable)
              .where(eq(JobTable.notification_id, job.info.notificationID))
              .run()
              .pipe(Effect.orDie)
        } else if (persist && !job.settling) yield* persistBackground(next)
        return [
          {
            info: snapshot(next),
            done: job.done,
            scope: job.scope,
            generation: job.scope,
            cancel: job.cancel,
            listed: listed(next.info, job.recovery),
          },
          new Map(jobs).set(id, next),
        ]
      }),
    )
    if (result.cancel) yield* result.cancel
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.done) yield* updated(result.listed)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    if (result.generation) yield* consume(id, result.generation)
    return result.info
  })

  const cancel: Interface["cancel"] = Effect.fn("Job.cancel")((id, options) => cancelInternal(id, true, options))

  const cancelSession: Interface["cancelSession"] = Effect.fn("Job.cancelSession")(function* (sessionID) {
    const ids = [...(yield* SynchronizedRef.get(state.jobs)).values()]
      .filter((job) => job.info.status === "running" && matchesSession(job, sessionID))
      .map((job) => job.info.id)
    const cancelled = yield* Effect.forEach(ids, (id) => cancelInternal(id, false))
    yield* db
      .delete(JobTable)
      .where(or(eq(JobTable.session_id, sessionID), eq(JobTable.child_session_id, sessionID)))
      .run()
      .pipe(Effect.orDie)
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const next = new Map(jobs)
      for (const [id, job] of jobs) {
        if (matchesSession(job, sessionID)) next.delete(id)
      }
      return next
    })
    return cancelled.filter((info): info is Info => info !== undefined)
  })

  const pendingBackground: Interface["pendingBackground"] = Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(JobTable)
      .orderBy(asc(JobTable.time_created), asc(JobTable.notification_id))
      .all()
      .pipe(Effect.orDie)
    return Array.filterMap(rows, (row) =>
      decodeBackground({
        id: row.id,
        notificationID: row.notification_id,
        recovery: row.recovery,
        status: row.status,
        ...(row.output !== null ? { output: row.output } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
      }),
    )
  }).pipe(Effect.withSpan("Job.pendingBackground"))

  const runningBackground: Interface["runningBackground"] = SynchronizedRef.get(state.jobs).pipe(
    Effect.map((jobs) =>
      [...jobs.values()].flatMap((job) =>
        job.isBackgrounded && job.info.status === "running" && !job.settling && !job.consumed && job.recovery
          ? [job.recovery]
          : [],
      ),
    ),
    Effect.withSpan("Job.runningBackground"),
  )

  const completeBackground: Interface["completeBackground"] = Effect.fn("Job.completeBackground")((notificationID) =>
    SynchronizedRef.updateEffect(state.jobs, (jobs) =>
      Effect.gen(function* () {
        yield* db.delete(JobTable).where(eq(JobTable.notification_id, notificationID)).run().pipe(Effect.orDie)
        const entry = [...jobs].find(([, job]) => job.info.notificationID === notificationID)
        if (!entry) return jobs
        // Still-running work keeps its entry, but must not persist its row again when it settles.
        if (entry[1].info.status === "running") return new Map(jobs).set(entry[0], { ...entry[1], consumed: true })
        const next = new Map(jobs)
        next.delete(entry[0])
        return next
      }),
    ),
  )

  const currentGeneration: Interface["currentGeneration"] = Effect.fn("Job.currentGeneration")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return undefined
    return { generation: job.generation, running: job.info.status === "running" && !job.settling }
  })

  const isCancelled: Interface["isCancelled"] = Effect.fn("Job.isCancelled")(function* (id) {
    return (yield* SynchronizedRef.get(state.jobs)).get(id)?.cancelledByCaller === true
  })

  const prepareSubagentReport: Interface["prepareSubagentReport"] = Effect.fn("Job.prepareSubagentReport")(
    function* (id, boundGeneration) {
      return yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [SubagentReportState, Map<string, Active>] => {
        const job = jobs.get(id)
        // A suppressed cancel silences only the period it cancelled; later periods report as usual.
        if (job?.suppressed && job.info.status === "cancelled")
          return [{ mode: "suppressed" }, new Map(jobs).set(id, { ...job, suppressed: false, reported: true })]
        // A generation reports at most once, even when an earlier attempt only observed a cancel.
        if (!job?.isBackgrounded || job.reported || !job.info.notificationID || job.recovery?.kind !== "subagent") {
          return [{ mode: "none" }, jobs]
        }
        const live = job.info.status === "running" && !job.settling
        // A cancel within this busy period already consumed the live entry, but it still belongs
        // here. A creation-tick interruption never bound a generation, so any cancel matches.
        const cancelled =
          job.info.status === "cancelled" && (boundGeneration === undefined || job.generation === boundGeneration)
        if (!live && !cancelled) return [{ mode: "none" }, jobs]
        const updated: Active = {
          ...job,
          reported: true,
          ...(job.info.status === "running" ? { settling: true } : {}),
        }
        const next = new Map(jobs).set(id, updated)
        return [
          {
            mode: "background",
            notificationID: job.info.notificationID,
            recovery: job.recovery,
            startedAt: job.info.started_at,
          },
          next,
        ]
      })
    },
  )

  // Called from inside Bus.publish's BEGIN IMMEDIATE commit callback: pure SQL only, never state.jobs.
  const recordSubagentReport: Interface["recordSubagentReport"] = Effect.fn("Job.recordSubagentReport")(
    function* (report) {
      const now = yield* Clock.currentTimeMillis
      yield* db
        .insert(JobTable)
        .values({
          notification_id: report.notificationID,
          id: report.recovery.childSessionID,
          session_id: report.recovery.parentSessionID,
          child_session_id: report.recovery.childSessionID,
          kind: "subagent",
          title: report.recovery.description,
          status: report.status,
          output: report.output ?? null,
          error: report.error ?? null,
          recovery: report.recovery,
          time_created: report.startedAt ?? now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: JobTable.notification_id,
          set: {
            status: report.status,
            output: report.output ?? null,
            error: report.error ?? null,
            recovery: report.recovery,
            time_updated: now,
          },
        })
        .run()
        .pipe(Effect.orDie)
    },
  )

  const deleteBackgroundRow: Interface["deleteBackgroundRow"] = Effect.fn("Job.deleteBackgroundRow")((notificationID) =>
    db.delete(JobTable).where(eq(JobTable.notification_id, notificationID)).run().pipe(Effect.orDie, Effect.asVoid),
  )

  const list: Interface["list"] = SynchronizedRef.get(state.jobs).pipe(
    Effect.map((jobs) =>
      Array.fromIterable(jobs.values()).map((job) => ({
        ...snapshot(job),
        ...(job.recovery ? { recovery: job.recovery } : {}),
      })),
    ),
  )

  const pause: Interface["pause"] = Effect.fn("Job.pause")((sessionID) =>
    Clock.currentTimeMillis.pipe(Effect.flatMap((at) => kv.set(`${pausePrefix}${sessionID}`, { at }))),
  )
  const unpause: Interface["unpause"] = Effect.fn("Job.unpause")((sessionID) => kv.remove(`${pausePrefix}${sessionID}`))
  const paused: Interface["paused"] = Effect.fn("Job.paused")((sessionID) =>
    kv.get(`${pausePrefix}${sessionID}`).pipe(Effect.map((value) => value !== undefined)),
  )

  return Service.of({
    get,
    start,
    wait,
    block,
    background,
    backgroundAll,
    cancel,
    cancelSession,
    pendingBackground,
    runningBackground,
    backgroundJobs: JobList.read(db, state.jobs),
    completeBackground,
    isCancelled,
    currentGeneration,
    prepareSubagentReport,
    recordSubagentReport,
    deleteBackgroundRow,
    list,
    pause,
    unpause,
    paused,
  })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, KV.node, Bus.node] })
