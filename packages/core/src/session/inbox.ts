export * as SessionInbox from "./inbox.js"

import { and, asc, eq, or } from "drizzle-orm"
import { Context, DateTime, Deferred, Effect, Layer, Option, Schema, Scope } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
} from "@opencode/schema/session-inbox"
import { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { Bus } from "../bus.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionDelegation } from "./delegation.js"
import { SessionBlob } from "./blob.js"
import { SessionStored } from "./stored.js"
import { SessionInboxTable, SessionMessageTable } from "./sql.js"
import { SessionHistory } from "./history.js"

type DatabaseService = Database.Interface["db"]

/** Private freshness fact, not retained bus history or an instruction-compaction epoch. */
export const userAdmissionKey = (sessionID: SessionSchema.ID) => `session:user-admission:${sessionID}`

export {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  MediaInfo,
  MediaUser,
  MediaUserPayload,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
}

/**
 * Which pending input `promote` may consume: "steer" promotes steers only (a step
 * boundary mid-work), while "input" also allows one queued input when no steers are
 * waiting (the idle boundary, where the Session picks up fresh work).
 */
export type Promotable = "input" | "steer"

const decodeUser = Schema.decodeUnknownSync(UserPayload)
const decodeMediaUser = Schema.decodeUnknownSync(MediaUserPayload)
const decodeStoredUser = Schema.decodeUnknownSync(SessionStored.UserPayload)
const encodeStoredUser = Schema.encodeSync(SessionStored.UserPayload)
const decodeSynthetic = Schema.decodeUnknownSync(SyntheticPayload)
const encodeSynthetic = Schema.encodeSync(SyntheticPayload)
const decodeCompaction = Schema.decodeUnknownSync(CompactionPayload)
const encodeCompaction = Schema.encodeSync(CompactionPayload)
const decodeMove = Schema.decodeUnknownSync(MovePayload)
const encodeMove = Schema.encodeSync(MovePayload)
const inboxLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
type PendingRef = { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID }

export const serialized = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
  inboxLocks.withLock(sessionID)(effect)

/** Serialised dispatch ownership; automatic steering invalidation is disabled. */
export interface SteeringGate {
  readonly invalidated: () => boolean
  readonly changed: Effect.Effect<void>
  readonly guard: <A, E, R>(start: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
  readonly finish: Effect.Effect<void>
}

const steering = new Map<SessionSchema.ID, Set<() => Effect.Effect<void>>>()
const notifySteer = (sessionID: SessionSchema.ID) =>
  Effect.forEach(steering.get(sessionID) ?? [], (notify) => notify(), { discard: true })

/** Register before inspecting pending input; registration and dispatch share the inbox mutex. */
export const watch = Effect.fn("SessionInbox.watch")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
): Effect.fn.Return<SteeringGate, never, Scope.Scope> {
  const changed = yield* Deferred.make<void>()
  const invalidated = false
  // Automatic cancellation is deliberately disabled: input is delivered at the
  // next ordinary boundary, never by cancelling and regenerating a response.
  // Keep dispatch ownership and inbox serialisation; explicit interruption and
  // provider/network cancellation use their separate, unchanged paths.
  const notify = () => Effect.void
  yield* Effect.acquireRelease(
    serialized(
      sessionID,
      Effect.sync(() => {
        const listeners = steering.get(sessionID) ?? new Set()
        listeners.add(notify)
        steering.set(sessionID, listeners)
      }),
    ),
    () =>
      serialized(
        sessionID,
        Effect.sync(() => {
          const listeners = steering.get(sessionID)
          listeners?.delete(notify)
          if (listeners?.size === 0) steering.delete(sessionID)
        }),
      ),
  )
  yield* serialized(
    sessionID,
    Effect.gen(function* () {
      // Keep the existing admission/control ordering machinery, but notification
      // is inert even for input already pending when a physical retry registers.
      const pending = yield* list(db, sessionID)
      if (pending.some((item) => item.delivery === "steer" && (item.type === "user" || item.type === "synthetic")))
        yield* notify()
    }),
  )
  return {
    invalidated: () => invalidated,
    changed: Deferred.await(changed),
    guard: (start) =>
      serialized(
        sessionID,
        Effect.suspend(() => (invalidated ? Effect.succeed(Option.none()) : start.pipe(Effect.map(Option.some)))),
      ).pipe(Effect.uninterruptible),
    finish: serialized(
      sessionID,
      Effect.sync(() => {
        const listeners = steering.get(sessionID)
        listeners?.delete(notify)
        if (listeners?.size === 0) steering.delete(sessionID)
      }),
    ),
  }
})

export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()("SessionInbox.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

function matches<Type extends Item["type"]>(
  stored: Info,
  request: PendingRef & { readonly type: Type },
): stored is Extract<Info, { readonly type: Type }> {
  return stored.sessionID === request.sessionID && stored.type === request.type
}

const fromRow = (row: typeof SessionInboxTable.$inferSelect): Info => {
  const base = {
    id: row.id,
    sessionID: row.session_id,
    time: { created: DateTime.makeUnsafe(row.time_created) },
  }
  if (row.type === "compaction")
    return Compaction.make({
      ...base,
      type: "compaction",
      payload: decodeCompaction(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "move")
    return Move.make({ ...base, type: "move", payload: decodeMove(row.payload), delivery: row.delivery })
  if (row.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: decodeUser(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: decodeSynthetic(row.payload),
      delivery: row.delivery,
    })
  throw new LifecycleConflict({ id: base.id })
}

export const find = Effect.fn("SessionInbox.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie)
  if (row === undefined) return undefined
  const [hydrated] = yield* SessionBlob.hydrateInbox(db, [row])
  return hydrated && fromRow(hydrated)
})

const promotedFromMessage = Effect.fn("SessionInbox.promotedFromMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  if (row.session_id !== sessionID || (row.type !== "user" && row.type !== "synthetic"))
    return yield* new LifecycleConflict({ id })
  const [message] = yield* SessionHistory.decodeMessageRows(db, [row]).pipe(Effect.orDie)
  if (!message) return undefined
  const base = { id, sessionID, time: { created: message.time.created }, delivery }
  if (message.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: UserPayload.make({
        text: message.text,
        files: message.files,
        agents: message.agents,
        skills: message.skills,
        metadata: message.metadata,
      }),
    })
  if (message.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: SyntheticPayload.make({
        text: message.text,
        description: message.description,
        metadata: message.metadata,
      }),
    })
})

export type Interface = Effect.Success<ReturnType<typeof make>>

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInbox") {}

export const make = Effect.fn("SessionInbox.make")(function* () {
  const database = yield* Database.Service
  const db = database.db
  const bus = yield* Bus.Service

  /** First admission wins for matching Session and type, without preparing a new payload. */
  const reconcile = Effect.fn("SessionInbox.reconcile")(function* <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly type: Type
    readonly delivery: Delivery
  }) {
    const existing =
      (yield* find(db, request.id)) ?? (yield* promotedFromMessage(db, request.sessionID, request.id, request.delivery))
    if (existing === undefined) return undefined
    if (existing.type === "compaction" || !matches(existing, request))
      return yield* new LifecycleConflict({ id: request.id })
    return existing
  })

  const admitLocked = <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item & { readonly type: Type }
    /** Local projection committed in the same transaction as the admission; its failure rejects the admission. */
    readonly commit?: (seq: number) => Effect.Effect<void>
  }) =>
    Effect.gen(function* () {
      const existing = yield* reconcile({ ...request, type: request.item.type, delivery: request.item.delivery })
      if (existing !== undefined) return existing
      let committed = false
      const admitted = yield* bus
        .publish(
          SessionEvent.InboxEnqueued,
          {
            inboxID: request.id,
            sessionID: request.sessionID,
            item: request.item,
          },
          request.commit ? { commit: request.commit } : undefined,
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              committed = true
            }),
          ),
          Effect.map((event) =>
            Info.make({
              id: request.id,
              sessionID: request.sessionID,
              time: { created: DateTime.makeUnsafe(event.created) },
              ...request.item,
            }),
          ),
          Effect.catchDefect((defect) =>
            defect instanceof LifecycleConflict
              ? find(db, request.id).pipe(
                  Effect.flatMap((stored) => (stored === undefined ? Effect.fail(defect) : Effect.succeed(stored))),
                )
              : Effect.die(defect),
          ),
        )
      if (!matches(admitted, { ...request, type: request.item.type }))
        return yield* new LifecycleConflict({ id: request.id })
      if (committed && admitted.delivery === "steer" && (admitted.type === "user" || admitted.type === "synthetic"))
        yield* notifySteer(request.sessionID)
      return admitted
    })

  const admit = <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item & { readonly type: Type }
  }) => serialized(request.sessionID, admitLocked<Type>(request)).pipe(Effect.uninterruptible)

  const admitCompaction = Effect.fn("SessionInbox.admitCompaction")(function* (input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly delivery: Delivery
    /** Internal: a controller-state binding, durable in the payload; a bound request never coalesces. */
    readonly checkpoint?: CompactionPayload["checkpoint"]
    readonly commit?: (seq: number) => Effect.Effect<void>
  }) {
    return yield* serialized(
      input.sessionID,
      Effect.gen(function* () {
        const exact = yield* find(db, input.id)
        if (exact) {
          if (exact.type === "compaction" && exact.sessionID === input.sessionID) return exact
          return yield* new LifecycleConflict({ id: input.id })
        }
        if (yield* promotedFromMessage(db, input.sessionID, input.id, input.delivery))
          return yield* new LifecycleConflict({ id: input.id })
        const pending = (yield* list(db, input.sessionID)).find((item) => item.type === "compaction")
        if (pending) return input.checkpoint ? yield* new LifecycleConflict({ id: input.id }) : pending
        return yield* admitLocked({
          id: input.id,
          sessionID: input.sessionID,
          item: {
            type: "compaction",
            payload: input.checkpoint ? { checkpoint: input.checkpoint } : {},
            delivery: input.delivery,
          },
          commit: input.commit,
        })
      }),
    )
  })

  const cancel = Effect.fn("SessionInbox.cancel")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxCancelled, {
        sessionID: input.sessionID,
        inboxID: input.id,
      }),
    ),
  )

  const steer = Effect.fn("SessionInbox.steer")((input: PendingRef) =>
    publishMutation(
      input,
      Effect.gen(function* () {
        const pending = yield* find(db, input.id)
        yield* bus.publish(SessionEvent.InboxDeliveryChanged, {
          sessionID: input.sessionID,
          inboxID: input.id,
          delivery: "steer",
        })
        if (pending?.type === "user" || pending?.type === "synthetic") yield* notifySteer(input.sessionID)
      }),
    ),
  )

  const queue = Effect.fn("SessionInbox.queue")((input: PendingRef) =>
    publishMutation(
      input,
      bus.publish(SessionEvent.InboxDeliveryChanged, {
        sessionID: input.sessionID,
        inboxID: input.id,
        delivery: "queue",
      }),
    ),
  )

  return {
    list: (sessionID: SessionSchema.ID) => list(db, sessionID),
    reconcile,
    admit,
    /** Internal control paths must already hold `serialized`; the mutex is not re-entrant. */
    admitMoveLocked: (request: PendingRef & { readonly item: Extract<Item, { readonly type: "move" }> }) =>
      admitLocked<"move">(request),
    admitCompaction,
    cancel,
    steer,
    queue,
  }
})

export const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })

export const projectAdmitted = Effect.fn("SessionInbox.projectAdmitted")(function* (
  db: DatabaseService,
  request: {
    readonly enqueuedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item
    readonly timeCreated: number
  },
) {
  yield* SessionDelegation.open(db, request.sessionID)
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, request.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  const payload =
    request.item.type === "user"
      ? encodeStoredUser(yield* SessionBlob.externalizePayload(db, request.item.payload))
      : request.item.type === "synthetic"
        ? encodeSynthetic(request.item.payload)
        : request.item.type === "compaction"
          ? encodeCompaction(request.item.payload)
          : encodeMove(request.item.payload)
  const stored = yield* db
    .insert(SessionInboxTable)
    .values({
      id: request.id,
      session_id: request.sessionID,
      type: request.item.type,
      payload,
      delivery: request.item.delivery,
      enqueued_seq: request.enqueuedSeq,
      time_created: request.timeCreated,
    })
    .onConflictDoNothing()
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  // The enqueue projection runs inside the bus transaction. A failed insert or
  // idempotent admission never advances this revision; delivery/cancellation do not erase it.
  if (request.item.type === "user")
    yield* db
      .insert(KVTable)
      .values({ key: userAdmissionKey(request.sessionID), value: request.enqueuedSeq })
      .onConflictDoUpdate({ target: KVTable.key, set: { value: request.enqueuedSeq } })
      .run()
      .pipe(Effect.orDie)
  yield* SessionBlob.recordRefs(
    db,
    { sessionID: request.sessionID, messageID: request.id, seq: request.enqueuedSeq },
    payload,
  )
})

/**
 * Consume one pending row at promotion. The row's content feeds the projected
 * message insert inside the same event transaction; the deleted row is what
 * makes the table pending-only.
 */
export const projectDelivered = Effect.fn("SessionInbox.projectDelivered")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(and(eq(SessionInboxTable.id, input.id), eq(SessionInboxTable.session_id, input.sessionID)))
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return delivered(deleted)
})

/** A consumed row with its payload as stored, so user file refs reach the message without their blobs. */
export type Delivered =
  | { readonly id: SessionMessage.ID; readonly type: "user"; readonly payload: SessionStored.UserPayload }
  | { readonly id: SessionMessage.ID; readonly type: "synthetic"; readonly payload: SyntheticPayload }
  | { readonly id: SessionMessage.ID; readonly type: "compaction" | "move" }

const delivered = (row: typeof SessionInboxTable.$inferSelect): Delivered => {
  if (row.type === "user") return { id: row.id, type: "user", payload: decodeStoredUser(row.payload) }
  if (row.type === "synthetic") return { id: row.id, type: "synthetic", payload: decodeSynthetic(row.payload) }
  return { id: row.id, type: row.type }
}

export const projectCancelled = Effect.fn("SessionInbox.projectCancelled")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        or(eq(SessionInboxTable.delivery, "queue"), eq(SessionInboxTable.delivery, "steer")),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  yield* SessionBlob.releaseMessage(db, input.sessionID, input.id)
})

const projectDelivery = Effect.fn("SessionInbox.projectDelivery")(function* (
  db: DatabaseService,
  input: PendingRef & { readonly from: Delivery; readonly to: Delivery },
) {
  const updated = yield* db
    .update(SessionInboxTable)
    .set({ delivery: input.to })
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        eq(SessionInboxTable.delivery, input.from),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectDeliveryChanged = Effect.fn("SessionInbox.projectDeliveryChanged")(
  (db: DatabaseService, input: PendingRef & { readonly delivery: Delivery }) =>
    projectDelivery(db, {
      ...input,
      from: input.delivery === "steer" ? "queue" : "steer",
      to: input.delivery,
    }),
)

const listRows = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, sessionID))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)

export const list = Effect.fn("SessionInbox.list")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* SessionBlob.hydrateInbox(db, yield* listRows(db, sessionID))).map(fromRow)
})

/** {@link list} for clients that fetch media themselves: files stored in `blob` stay `media:` refs. */
export const listWithRefs = Effect.fn("SessionInbox.listWithRefs")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const kept = yield* SessionBlob.keepInboxRefs(db, yield* listRows(db, sessionID))
  return kept.rows.map((row): MediaInfo => {
    if (row.type !== "user") return fromRow(row)
    const payload = decodeMediaUser(row.payload)
    return MediaUser.make({
      id: row.id,
      sessionID: row.session_id,
      time: { created: DateTime.makeUnsafe(row.time_created) },
      type: "user",
      payload: payload.files ? { ...payload, files: SessionBlob.describe(payload.files, kept.meta) } : payload,
      delivery: row.delivery,
    })
  })
})

export const moveIDs = Effect.fn("SessionInbox.moveIDs")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.type, "move")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)
})

/** "control" settles recovery controls without delivering the retained inputs ahead of them. */
export const nextPromotable = Effect.fn("SessionInbox.nextPromotable")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  promotable: Promotable | "control",
) {
  const steers = yield* pendingSteers(db, sessionID)
  const steer =
    promotable === "control" ? steers.find((row) => row.type === "compaction" || row.type === "move") : steers[0]
  if (steer) return promotion(steer)
  if (promotable === "steer") return undefined
  const queued = yield* db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "queue")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return queued && (promotable !== "control" || queued.type === "compaction" || queued.type === "move")
    ? promotion(queued)
    : undefined
})

/** What a boundary decides on: prompts are promoted by id, so only a move's payload is read. */
export type Promotion =
  | { readonly id: SessionMessage.ID; readonly type: "user" | "synthetic"; readonly delivery: Delivery }
  | {
      readonly id: SessionMessage.ID
      readonly type: "compaction"
      readonly delivery: Delivery
      readonly payload: CompactionPayload
    }
  | {
      readonly id: SessionMessage.ID
      readonly type: "move"
      readonly delivery: Delivery
      readonly payload: MovePayload
    }

const promotion = (row: typeof SessionInboxTable.$inferSelect): Promotion =>
  row.type === "move"
    ? { id: row.id, type: "move", delivery: row.delivery, payload: decodeMove(row.payload) }
    : row.type === "compaction"
      ? { id: row.id, type: row.type, delivery: row.delivery, payload: decodeCompaction(row.payload) }
      : { id: row.id, type: row.type, delivery: row.delivery }

/** Which pending rows count: "input" means any item in either delivery mode. */
export type Scope = "input" | Delivery

export const has = Effect.fn("SessionInbox.has")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  scope: Scope,
) {
  const row = yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.session_id, sessionID),
        scope === "input"
          ? or(eq(SessionInboxTable.delivery, "steer"), eq(SessionInboxTable.delivery, "queue"))
          : eq(SessionInboxTable.delivery, scope),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

const publishMutation = <A, E, R>(input: PendingRef, effect: Effect.Effect<A, E, R>) =>
  serialized(input.sessionID, effect).pipe(
    Effect.uninterruptible,
    Effect.asVoid,
    // Bus projectors abort their transaction through the defect channel.
    Effect.catchDefect((defect) => (defect instanceof LifecycleConflict ? Effect.fail(defect) : Effect.die(defect))),
  )

const publish = Effect.fn("SessionInbox.publish")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInboxTable.$inferSelect>,
) {
  yield* Effect.forEach(
    rows,
    (row) => {
      if (row.type !== "move" && row.type !== "user" && row.type !== "synthetic")
        return Effect.die(new LifecycleConflict({ id: row.id }))
      return bus
        .publish(SessionEvent.InboxDelivered, {
          sessionID,
          inboxID: row.id,
        })
        .pipe(
          Effect.catchDefect((defect) =>
            defect instanceof LifecycleConflict
              ? promotedFromMessage(db, sessionID, row.id, row.delivery).pipe(
                  Effect.flatMap((stored) => (stored !== undefined ? Effect.void : Effect.die(defect))),
                  Effect.orDie,
                )
              : Effect.die(defect),
          ),
        )
    },
    { discard: true },
  )
  return rows.length
})

/**
 * Promotes pending input into visible messages and returns the promoted count,
 * or undefined when the runner must first handle a pending control.
 * Steered compaction takes priority over pending prompts, without crossing a move.
 * Only the "input" scope may fall through to one queued input.
 */
export const promote = Effect.fn("SessionInbox.promote")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  scope: Promotable,
) {
  return yield* serialized(
    sessionID,
    Effect.gen(function* () {
      const steers = yield* pendingSteers(db, sessionID)
      if (steers.length > 0 || scope === "steer") {
        const control = steers.findIndex((row) => row.type === "compaction" || row.type === "move")
        if (control === 0) return undefined
        return yield* publish(db, bus, sessionID, control === -1 ? steers : steers.slice(0, control))
      }

      const queued = yield* db
        .select()
        .from(SessionInboxTable)
        .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "queue")))
        .orderBy(asc(SessionInboxTable.enqueued_seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!queued) return 0
      if (queued.type === "compaction" || queued.type === "move") return undefined
      const promoted = yield* publish(db, bus, sessionID, [queued])
      const arrivedSteers = yield* pendingSteers(db, sessionID)
      const control = arrivedSteers.findIndex((row) => row.type === "compaction" || row.type === "move")
      return (
        promoted +
        (yield* publish(db, bus, sessionID, control === -1 ? arrivedSteers : arrivedSteers.slice(0, control)))
      )
    }),
  )
})

const pendingSteers = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select()
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.delivery, "steer")))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        // A move changes the context's Location: never pull compaction across it.
        // Within that boundary, compact before promoting even earlier steers so
        // their text stays verbatim after the checkpoint, not inside its summary.
        const control = rows.findIndex((row) => row.type === "compaction" || row.type === "move")
        if (control > 0 && rows[control].type === "compaction") rows.unshift(...rows.splice(control, 1))
        return rows
      }),
    )
