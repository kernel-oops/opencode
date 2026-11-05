export * as Job from "./job.js"

import { asc, eq, or } from "drizzle-orm"
import { Array, Cause, Clock, Context, Deferred, Effect, Exit, Layer, Schema, Scope, SynchronizedRef } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "./database/database.js"
import { JobTable } from "./job/sql.js"
import { KV } from "./kv.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"

const Background = Schema.Struct({
  id: Schema.String,
  notificationID: SessionMessage.ID,
  recovery: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("shell"),
      sessionID: SessionSchema.ID,
      shellID: Schema.String,
      command: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("subagent"),
      parentSessionID: SessionSchema.ID,
      childSessionID: SessionSchema.ID,
      agent: Schema.String,
      description: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("image"),
      sessionID: SessionSchema.ID,
      path: Schema.String,
      model: Schema.String,
    }),
  ]),
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})

export type Background = typeof Background.Type
export type Recovery = Background["recovery"]
export type Status = Background["status"]

const decodeBackground = Schema.decodeUnknownResult(Background)
const pausePrefix = "job.paused/"
const COMPLETED_LIMIT = 25

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
  blockingSessions: Map<SessionSchema.ID, number>
  isBackgrounded: boolean
  consumed: boolean
  recovery?: Recovery
  delivery: { owner?: "foreground" | "background"; claimed?: "foreground" | "background"; observed: boolean }
  revision: number
  continuation?: Effect.Effect<string, unknown>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
  generation?: Scope.Closeable
  continuation?: { run: Effect.Effect<string, unknown>; revision: number }
}

type BackgroundResult = {
  info?: Info
  backgrounded?: Deferred.Deferred<Info>
}

type StartResult = { job: Active; scope?: Scope.Closeable }

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
  /** An unflagged follow-up must not reclaim a running background generation. */
  preserveBackground?: boolean
  /** Automatic follow-ups only create a background generation; never alter an existing owner. */
  onlyIfIdle?: boolean
  run: Effect.Effect<string, unknown>
}

/** Captures one run generation; operations never look up a successor by child ID. */
export type Acquired = {
  readonly created: boolean
  readonly info: Info
  readonly wait: Effect.Effect<Info>
  readonly block: Effect.Effect<BlockResult>
  readonly background: Effect.Effect<Info | undefined>
  /** `accept` only accepts interruption of the owned execution; it must never await cleanup or run hooks. */
  readonly cancel: (options?: CancelOptions, accept?: Effect.Effect<void>) => Effect.Effect<Info | undefined>
  readonly observe: Effect.Effect<boolean>
  readonly claimBackground: Effect.Effect<boolean>
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

export type CancelOptions = {
  /** Drop the completion notification and durable marker so the parent is never woken by this cancellation. */
  suppress?: boolean
}

export type Listed = Info & { recovery?: Recovery }

export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly acquire: (input: StartInput, foreground?: SessionSchema.ID) => Effect.Effect<Acquired>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly block: (input: BlockInput) => Effect.Effect<BlockResult | undefined>
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  readonly backgroundAll: (input: BackgroundAllInput) => Effect.Effect<Info[]>
  readonly cancel: (id: string, options?: CancelOptions) => Effect.Effect<Info | undefined>
  readonly cancelSession: (sessionID: SessionSchema.ID) => Effect.Effect<Info[]>
  readonly pendingBackground: Effect.Effect<readonly Background[]>
  readonly runningBackground: Effect.Effect<readonly Recovery[]>
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
  /** Snapshots every process-local job with its recovery record. */
  readonly list: Effect.Effect<readonly Listed[]>
  /** Durably pauses completion delivery for a parent Session until `unpause`. */
  readonly pause: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly unpause: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly paused: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

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
    scope: yield* Scope.Scope,
  }

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

  const settle = Effect.fnUntraced(function* (
    id: string,
    scope: Scope.Closeable,
    exit: Exit.Exit<string, unknown>,
    revision: number,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.scope !== scope) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
        // A continuation acquired this generation while its previous drain was settling.
        if (job.revision !== revision && job.continuation)
          return [{ continuation: { run: job.continuation, revision: job.revision } }, jobs]
        const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
          ? "completed"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "error"
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status,
            completed_at,
            ...(Exit.isSuccess(exit) ? { output: exit.value } : {}),
            ...(Exit.isFailure(exit) ? { error: errorText(exit.cause) } : {}),
          },
        }
        if (job.delivery.owner === "foreground") job.delivery.claimed = "foreground"
        if (status !== "cancelled") yield* persistBackground(next)
        return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result
  })

  const get: Interface["get"] = Effect.fn("Job.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return undefined
    return snapshot(job)
  })

  const acquire = Effect.fnUntraced(function* (
    input: StartInput,
    foreground?: SessionSchema.ID,
    extend = true,
  ): Effect.fn.Return<Acquired> {
    return yield* Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const backgrounded = yield* Deferred.make<Info>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [StartResult, Map<string, Active>]> {
            const existing = jobs.get(input.id)
            if (existing?.info.status === "running") {
              if (input.onlyIfIdle) return [{ job: existing }, jobs]
              const reclaim = foreground && !(input.preserveBackground && existing.isBackgrounded)
              if (reclaim) existing.delivery.owner = "foreground"
              const updated = reclaim
                ? {
                    ...existing,
                    isBackgrounded: false,
                    backgrounded: existing.isBackgrounded ? backgrounded : existing.backgrounded,
                    blockingSessions: incrementSession(existing.blockingSessions, foreground),
                  }
                : existing
              const job = extend ? { ...updated, revision: updated.revision + 1, continuation: input.run } : updated
              return [{ job }, new Map(jobs).set(input.id, job)]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const job = {
              info: {
                id: input.id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
                ...(input.notificationID ? { notificationID: input.notificationID } : {}),
              },
              done,
              backgrounded,
              scope,
              blockingSessions: foreground ? new Map([[foreground, 1]]) : new Map<SessionSchema.ID, number>(),
              isBackgrounded: false,
              consumed: false,
              recovery: input.recovery,
              delivery: { observed: false, owner: foreground ? ("foreground" as const) : undefined },
              revision: 0,
            }
            const active = input.onlyIfIdle ? yield* markBackground(job) : job
            return [{ job: active, scope }, new Map(jobs).set(input.id, active)]
          }),
        )
        if (result.scope && input.onlyIfIdle) yield* Deferred.succeed(backgrounded, snapshot(result.job))
        if (result.scope) {
          const scope = result.scope
          yield* Effect.gen(function* () {
            let run = input.run
            let revision = 0
            while (true) {
              const exit = yield* Effect.interruptible(run).pipe(Effect.exit)
              const settled = yield* settle(input.id, scope, exit, revision)
              if (!settled.continuation) return
              run = settled.continuation.run
              revision = settled.continuation.revision
            }
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
        }
        const job = result.job
        const info = snapshot(job)
        return {
          created: result.scope !== undefined,
          info,
          wait: Deferred.await(job.done),
          block: Effect.raceFirst(
            Deferred.await(job.done).pipe(Effect.map((info) => ({ type: "finished" as const, info }))),
            Deferred.await(job.backgrounded).pipe(Effect.map((info) => ({ type: "backgrounded" as const, info }))),
          ).pipe(
            Effect.tap((outcome) => (outcome.type === "finished" ? consume(input.id, job.scope) : Effect.void)),
            Effect.ensuring(
              foreground
                ? removeBlock({ id: input.id, sessionID: foreground }, job.scope, job.backgrounded)
                : Effect.void,
            ),
          ),
          background: background(input.id, job.scope),
          cancel: (options?: CancelOptions, accept?: Effect.Effect<void>) =>
            cancel(input.id, options, job.scope, accept),
          observe: SynchronizedRef.modify(state.jobs, (jobs) => {
            if (job.delivery.observed) return [false, jobs]
            job.delivery.observed = true
            return [true, jobs]
          }),
          claimBackground: SynchronizedRef.modify(state.jobs, (jobs) => {
            if (job.delivery.claimed) return [false, jobs]
            job.delivery.claimed = "background"
            return [true, jobs]
          }),
        }
      }),
    )
  })

  const start: Interface["start"] = (input) =>
    acquire(input, undefined, false).pipe(Effect.map((handle) => handle.info))

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

  const removeBlock = Effect.fnUntraced(function* (
    input: BlockInput,
    generation?: Scope.Closeable,
    release?: Deferred.Deferred<Info>,
  ) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(input.id)
      if (!job || (generation && job.scope !== generation) || job.info.status !== "running" || job.isBackgrounded)
        return jobs
      if (release && job.backgrounded !== release) return jobs
      return new Map(jobs).set(input.id, {
        ...job,
        blockingSessions: decrementSession(job.blockingSessions, input.sessionID),
      })
    })
  })

  const block: Interface["block"] = Effect.fnUntraced(function* (input) {
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [BlockStart, Map<string, Active>] => {
      const job = jobs.get(input.id)
      if (!job) return [{ type: "missing" }, jobs]
      if (job.info.status !== "running") return [{ type: "finished", info: snapshot(job), generation: job.scope }, jobs]
      if (job.isBackgrounded) return [{ type: "backgrounded", info: snapshot(job) }, jobs]
      return [
        { type: "wait", wait: { done: job.done, backgrounded: job.backgrounded, generation: job.scope } },
        new Map(jobs).set(input.id, {
          ...job,
          blockingSessions: incrementSession(job.blockingSessions, input.sessionID),
        }),
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
      Effect.ensuring(removeBlock(input, result.wait.generation, result.wait.backgrounded)),
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
    job.delivery.owner = "background"
    return next
  })

  const background = Effect.fn("Job.background")(function* (id: string, generation?: Scope.Closeable) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [BackgroundResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (generation && job?.scope !== generation) return [{}, jobs]
        // Recoverable work may finish before the caller backgrounds it.
        if (!job || (job.info.status !== "running" && !job.recovery)) return [{}, jobs]
        if (job.isBackgrounded) return [{ info: snapshot(job) }, jobs]
        const next = yield* markBackground(job)
        return [{ info: snapshot(next), backgrounded: job.backgrounded }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.backgrounded) yield* Deferred.succeed(result.backgrounded, result.info)
    return result.info
  })

  const backgroundAll: Interface["backgroundAll"] = Effect.fn("Job.backgroundAll")(function* (input) {
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
          next.set(id, updated)
        }
        return [results, next]
      }),
    )
    yield* Effect.forEach(result, (item) => Deferred.succeed(item.backgrounded, item.info), { discard: true })
    return result.map((item) => item.info)
  })

  const cancelInternal = Effect.fnUntraced(function* (
    id: string,
    options?: CancelOptions,
    generation?: Scope.Closeable,
    accept?: Effect.Effect<void>,
    persist = true,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (generation && job?.scope !== generation) return [{}, jobs]
        if (!job) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job), generation: job.scope }, jobs]
        if (accept) yield* accept
        const suppress = options?.suppress === true
        if (job.delivery.owner === "foreground") job.delivery.claimed = "foreground"
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status: "cancelled" as const,
            completed_at,
            ...(suppress ? { metadata: { ...job.info.metadata, suppressed: true } } : {}),
          },
        }
        // A suppressed cancellation leaves no durable notification for restart recovery to deliver.
        if (suppress && job.info.notificationID)
          yield* db.delete(JobTable).where(eq(JobTable.notification_id, job.info.notificationID)).run().pipe(Effect.orDie)
        else if (persist) yield* persistBackground(next)
        return [
          { info: snapshot(next), done: job.done, scope: job.scope, generation: job.scope },
          new Map(jobs).set(id, next),
        ]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    if (result.generation) yield* consume(id, result.generation)
    return result.info
  })

  const cancel = Effect.fn("Job.cancel")((id: string, options?: CancelOptions, generation?: Scope.Closeable, accept?: Effect.Effect<void>) =>
    cancelInternal(id, options, generation, accept))

  const cancelSession: Interface["cancelSession"] = Effect.fn("Job.cancelSession")(function* (sessionID) {
    const ids = [...(yield* SynchronizedRef.get(state.jobs)).values()]
      .filter((job) => job.info.status === "running" && matchesSession(job, sessionID))
      .map((job) => job.info.id)
    const cancelled = yield* Effect.forEach(ids, (id) => cancelInternal(id, undefined, undefined, undefined, false))
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
        job.isBackgrounded && job.info.status === "running" && job.recovery ? [job.recovery] : [],
      ),
    ),
    Effect.withSpan("Job.runningBackground"),
  )

  const completeBackground: Interface["completeBackground"] = Effect.fn("Job.completeBackground")((notificationID) =>
    SynchronizedRef.updateEffect(state.jobs, (jobs) =>
      Effect.gen(function* () {
        yield* db.delete(JobTable).where(eq(JobTable.notification_id, notificationID)).run().pipe(Effect.orDie)
        const entry = [...jobs].find(([, job]) => job.info.notificationID === notificationID)
        if (!entry || entry[1].info.status === "running") return jobs
        const next = new Map(jobs)
        next.delete(entry[0])
        return next
      }),
    ),
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
    acquire,
    wait,
    block,
    background,
    backgroundAll,
    cancel,
    cancelSession,
    pendingBackground,
    runningBackground,
    completeBackground,
    list,
    pause,
    unpause,
    paused,
  })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, KV.node] })
