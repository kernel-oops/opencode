export * as SessionStateCheckpoint from "./state-checkpoint.js"

import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm"
import { Clock, Effect, Option, Result, Schema } from "effect"
import { Hash } from "@opencode/util/hash"
import type {
  CheckpointBinding,
  CompactResult,
  Coverage as CoverageInfo,
  ErrorCode,
  MaintainInput,
  MaintainResult,
  Receipt,
  SnapshotResult,
  Source,
  State as StateInfo,
  Status,
  UpdateResult,
} from "@opencode/plugin/controller-state"
import type { CompactionPayload } from "@opencode/schema/session-inbox"
import type { Database } from "../database/database.js"
import { KVTable } from "../kv/sql.js"
import { CompactionConflictError, NotFoundError } from "./error.js"
import { checkpointBinding, decodeMessageRowSync, decodeMessageRows, decodeStoredRow, withParts } from "./history.js"
import { SessionContextBudget } from "./context-budget.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionReviewEvidence } from "./review-evidence.js"
import type { SessionSchema } from "./schema.js"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable, SessionTable } from "./sql.js"
import { SessionStateEnvelope } from "./state-envelope.js"

type DatabaseService = Database.Interface["db"]

export const SNAPSHOT_TTL = 15 * 60 * 1000
export const TOOL = "controller_state"
/** Only an active authority entry with this scope, quoting a whole root human prompt in this session, opts in. */
export const OPT_IN_SCOPE = "controller-state-checkpoint"
const { canonical, render } = SessionStateEnvelope

/** Core records, stored in the existing KV table. Versions are immutable; `current` is the CAS pointer. */
/** `sources` is the hash of the exact native rows the state cites, re-checked whenever the receipt is used. */
type Current = Receipt & { readonly snapshotID: string; readonly sources: string }
type Version = { readonly revision: number; readonly stateHash: string; readonly state: StateInfo; readonly source: Source }
type Snapshot = {
  readonly id: string
  readonly sessionID: string
  readonly source: Source
  readonly revision: number
  readonly coverage: CoverageInfo
  readonly expires: number
  readonly used?: boolean
}
type Outcome = NonNullable<Status["outcome"]>
/** The binding a checkpoint control carries in its durable payload; only core constructs it. */
export type Binding = NonNullable<CompactionPayload["checkpoint"]>

const prefix = (sessionID: string) => `session/state-checkpoint/${sessionID}/`
const keys = {
  current: SessionStateEnvelope.currentKey,
  version: (sessionID: string, revision: number) => `${prefix(sessionID)}version/${String(revision).padStart(10, "0")}`,
  snapshot: (sessionID: string, id: string) => `${prefix(sessionID)}snapshot/${id}`,
  outcome: (sessionID: string) => `${prefix(sessionID)}outcome`,
  intent: (sessionID: string) => `${prefix(sessionID)}intent`,
  released: (sessionID: string) => `${prefix(sessionID)}released`,
}

/** A checkpoint precondition failed inside the native commit; the transaction rolls back. */
export class Blocked extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
  }
}

const fail = (error: ErrorCode, message: string) => ({ ok: false as const, error, message })

const kvGet = (db: DatabaseService, key: string) =>
  db
    .select({ value: KVTable.value })
    .from(KVTable)
    .where(eq(KVTable.key, key))
    .get()
    .pipe(Effect.orDie, Effect.map((row) => row?.value as unknown))
const kvSet = (db: DatabaseService, key: string, value: unknown) =>
  db
    .insert(KVTable)
    .values({ key, value: value as Schema.Json })
    .onConflictDoUpdate({ target: KVTable.key, set: { value: value as Schema.Json } })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

const current = (db: DatabaseService, sessionID: string) =>
  kvGet(db, keys.current(sessionID)).pipe(Effect.map((value) => value as Current | undefined))

const latestCompleted = (db: DatabaseService, sessionID: string) =>
  db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID as never),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)

/**
 * Whether a compaction must take the checkpoint path: the session opted in (never inherited: every key is per
 * session ID), the trigger is a bound control, or, with the local receipt missing, a durable checkpoint or bound
 * control shows it did, or a checkpoint marking that does not bind here (a fork's copy). Those block as recovery
 * required instead of running an ordinary lossy summary.
 */
export const engaged = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID, bound?: Binding) {
  const pointer = yield* current(db, sessionID)
  const latest = yield* latestCompleted(db, sessionID)
  const binding = latest && (yield* checkpointBinding(db, sessionID, latest.id))
  if (binding === false) return true
  if (pointer) return pointer.enabled || bound !== undefined
  if (bound) return true
  if (binding !== undefined) return true
  return (yield* SessionInbox.list(db, sessionID)).some((item) => item.type === "compaction" && item.payload.checkpoint)
})

/** The tool call must be running now, in this session, as `controller_state`; a copied ID is not a capability. */
const live = Effect.fnUntraced(function* (db: DatabaseService, sessionID: string, source: Source) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.id, source.messageID as never), eq(SessionMessageTable.session_id, sessionID as never)))
    .get()
    .pipe(Effect.orDie)
  const message = row && (yield* decodeStoredRow((yield* withParts(db, [row]))[0]!).pipe(Effect.orDie))
  return (
    message?.type === "assistant" &&
    message.time.completed === undefined &&
    message.content.some(
      (part) => part.type === "tool" && part.id === source.callID && part.name === TOOL && part.state.status === "running",
    )
  )
})

const prefixRows = (db: DatabaseService, sessionID: string, from: number, through?: number) =>
  db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID as never),
        gte(SessionMessageTable.seq, from),
        through === undefined ? undefined : lte(SessionMessageTable.seq, through),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie, Effect.flatMap((rows) => withParts(db, rows)))

const rowsHash = (rows: ReadonlyArray<typeof SessionMessageTable.$inferSelect>) =>
  Hash.sha256(canonical(rows.map((row) => [row.seq, row.id, row.type, row.data])))

/** Native facts a coverage binds that can change without touching the covered rows. */
const basis = Effect.fnUntraced(function* (db: DatabaseService, sessionID: string) {
  const session = yield* db
    .select({ directory: SessionTable.directory, revert: SessionTable.revert })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID as never))
    .get()
    .pipe(Effect.orDie)
  const instructions = yield* db
    .select({ values: InstructionStateTable.current_values })
    .from(InstructionStateTable)
    .where(eq(InstructionStateTable.session_id, sessionID as never))
    .get()
    .pipe(Effect.orDie)
  const admission = yield* kvGet(db, SessionInbox.userAdmissionKey(sessionID as SessionSchema.ID))
  return {
    session,
    userAdmission: typeof admission === "number" ? admission : 0,
    instructionHash: Hash.sha256(canonical(instructions?.values ?? null)),
  }
})

/**
 * The shared coverage-window loader: the native context window after the latest completed compaction, as history
 * reads it. A controller checkpoint retains original rows from just after its coverage, which may precede its marker.
 */
const window = Effect.fnUntraced(function* (db: DatabaseService, sessionID: string) {
  const row = yield* latestCompleted(db, sessionID)
  if (!row) return { ok: true as const, checkpointSeq: 0, fromSeq: 0 }
  const message = decodeMessageRowSync(row)
  if (message.type !== "compaction" || message.status !== "completed")
    return { ok: true as const, checkpointSeq: row.seq, fromSeq: row.seq }
  // A provider-native window may be skipped for another model; every row since the start is a safe superset.
  if (message.native) return { ok: true as const, checkpointSeq: row.seq, fromSeq: 0 }
  const binding = yield* checkpointBinding(db, sessionID, message.id)
  const envelope = binding === undefined ? undefined : binding && SessionStateEnvelope.decode(message.summary, binding)
  if (envelope === false) return fail("recovery_required", "The latest checkpoint does not decode against its binding")
  if (envelope) return { ok: true as const, checkpointSeq: row.seq, fromSeq: Math.min(row.seq, envelope.coverage.coveredSeq + 1) }
  const keepID = message.metadata?.keepID
  const kept = Schema.is(SessionMessage.ID)(keepID)
    ? yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID as never), eq(SessionMessageTable.id, keepID)))
        .get()
        .pipe(Effect.orDie)
    : undefined
  return { ok: true as const, checkpointSeq: row.seq, fromSeq: Math.min(row.seq, kept?.seq ?? row.seq) }
})

/**
 * The settled prefix of the current window: it stops before the first running assistant or compaction, so no
 * unresolved tool call or pending native successor straddles it, and it must pass the latest checkpoint marker.
 */
const measure = Effect.fnUntraced(function* (db: DatabaseService, sessionID: string) {
  const facts = yield* basis(db, sessionID)
  if (!facts.session) return fail("invalid_source", "Session not found")
  if (facts.session.revert) return fail("unsettled", "A revert is staged")
  const range = yield* window(db, sessionID)
  if (!range.ok) return range
  const rows = yield* prefixRows(db, sessionID, range.fromSeq)
  const cut = yield* Effect.findFirst(rows, (row) => decodeStoredRow(row).pipe(Effect.orDie, Effect.map((message) => {
    if (message.type === "compaction") return message.status === "running"
    if (message.type !== "assistant") return false
    return (
      message.time.completed === undefined ||
      message.content.some((part) => part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error")
    )
  })))
  const settled = Option.isSome(cut) ? rows.slice(0, rows.indexOf(cut.value)) : rows
  const last = settled.at(-1)
  if (!last || last.seq <= range.checkpointSeq) return fail("unsettled", "No settled history after the latest checkpoint")
  return {
    ok: true as const,
    coverage: {
      checkpointSeq: range.checkpointSeq,
      fromSeq: range.fromSeq,
      coveredSeq: last.seq,
      coveredMessageID: last.id,
      prefixHash: rowsHash(settled),
      userAdmission: facts.userAdmission,
      instructionHash: facts.instructionHash,
      directory: facts.session.directory,
    } satisfies CoverageInfo,
  }
})

/**
 * Re-checks a coverage. Inside a checkpoint's own commit, `committed` is the exact checkpoint message it completed:
 * it must be the only checkpoint since the coverage's, carrying exactly the rendered state.
 */
const verify = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: string,
  coverage: CoverageInfo,
  committed?: { readonly id: string; readonly rendered: string; readonly revision: number; readonly stateHash: string },
) {
  const facts = yield* basis(db, sessionID)
  if (!facts.session || facts.session.revert) return "A revert is pending"
  if (facts.session.directory !== coverage.directory) return "The session moved to another directory"
  if (facts.userAdmission !== coverage.userAdmission) return "A user prompt was admitted after the reviewed snapshot"
  if (facts.instructionHash !== coverage.instructionHash) return "The instruction basis changed"
  const later = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID as never),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
        gt(SessionMessageTable.seq, coverage.checkpointSeq),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const own = later.map(decodeMessageRowSync)
  const expected =
    committed === undefined
      ? own.length === 0
      : own.length === 1 && own[0].id === committed.id && own[0].type === "compaction" && own[0].status === "completed" && own[0].summary === committed.rendered &&
        own[0].checkpoint?.revision === committed.revision && own[0].checkpoint.stateHash === committed.stateHash
  if (!expected) return "Another checkpoint completed after the reviewed snapshot"
  const rows = yield* prefixRows(db, sessionID, coverage.fromSeq, coverage.coveredSeq)
  if (rows.at(-1)?.id !== coverage.coveredMessageID || rowsHash(rows) !== coverage.prefixHash)
    return "The covered history changed after the reviewed snapshot"
  return undefined
})

const DECIMAL = /^-?\d+(\.\d+)?$/
const scaled = (values: ReadonlyArray<string>) => {
  const places = Math.max(...values.map((value) => value.split(".")[1]?.length ?? 0))
  return values.map((value) => {
    const [whole, fraction = ""] = value.split(".")
    return BigInt(whole + fraction.padEnd(places, "0"))
  })
}

/** Lineage, not co-residence: another session's message counts only from an ancestor of this session. */
const ancestors = Effect.fnUntraced(function* (db: DatabaseService, sessionID: string) {
  const found: string[] = []
  let next: string | undefined = sessionID
  while (next && found.length < 32) {
    const row: { parent: string | null } | undefined = yield* db
      .select({ parent: SessionTable.parent_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, next as never))
      .get()
      .pipe(Effect.orDie)
    next = row?.parent ?? undefined
    if (next) found.push(next)
  }
  return found
})

const refsOf = (state: StateInfo) => {
  const facts = [state.pins.candidate, state.pins.deployed, state.pins.canonical, ...state.jobs.map((job) => job.id), ...state.reminders.map((item) => item.id)]
  return [
    ...state.authority.flatMap((item) => [item.source, ...(item.supersededBy ? [item.supersededBy] : [])]),
    ...state.budgets.map((item) => item.source),
    ...facts.flatMap((fact) => fact.evidence),
    ...[...state.jobs, ...state.reminders, ...state.unresolved].flatMap((item) => item.evidence),
    ...state.evidence,
    ...state.review.reviewerEvidence,
  ]
}

/**
 * The exact stored bytes of every native message the state cites, wherever it lies in the session or its ancestry,
 * so a grant, reviewer note or settled call that changes after review invalidates the receipt. File references stay
 * unverified external evidence.
 */
const sources = Effect.fnUntraced(function* (db: DatabaseService, state: StateInfo) {
  const cited = [...new Set(refsOf(state).flatMap((ref) => (ref.kind === "message" ? [canonical([ref.sessionID, ref.messageID])] : [])))].sort()
  const rows: unknown[] = []
  for (const key of cited) {
    const [sessionID, messageID] = JSON.parse(key) as [string, string]
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.id, messageID as never), eq(SessionMessageTable.session_id, sessionID as never)))
      .get()
      .pipe(Effect.orDie)
    const materialised = row && (yield* withParts(db, [row]))[0]!
    rows.push(materialised ? [materialised.session_id, materialised.id, materialised.seq, materialised.type, materialised.data] : [sessionID, messageID, null])
  }
  return Hash.sha256(canonical(rows))
})

/** Whether the stored state still matches its receipt: its complete hash and every native source it cites. */
const stale = Effect.fnUntraced(function* (db: DatabaseService, sessionID: string, pointer: Current) {
  const version = (yield* kvGet(db, keys.version(sessionID, pointer.revision))) as Version | undefined
  if (
    !version ||
    SessionStateEnvelope.stateHash(version.state) !== pointer.stateHash ||
    canonical(version.state.review.currentThrough) !== canonical(pointer.coverage)
  )
    return { message: "Stored state does not match its receipt" }
  if ((yield* sources(db, version.state)) !== pointer.sources) return { message: "A native source the reviewed state cites changed" }
  return version
})

/** The exact native shell row authorising a maintenance operation. */
type Intent = { readonly seq: number; readonly messageID: string; readonly shellID: string; readonly command: string }

/**
 * Claims one native shell intent, inside the transaction of the operation it authorises: the same shell row must
 * still have exited successfully with exactly the command named, and a sequence at or below the last claimed one
 * was already used. Returns the failure, if any.
 */
const claim = Effect.fnUntraced(function* (db: DatabaseService, sessionID: string, intent: Intent) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID as never), eq(SessionMessageTable.id, intent.messageID as never)))
    .get()
    .pipe(Effect.orDie)
  const shell = row && (yield* decodeStoredRow(row).pipe(Effect.orDie))
  if (
    row?.seq !== intent.seq ||
    shell?.type !== "shell" ||
    shell.shellID !== intent.shellID ||
    shell.status !== "exited" ||
    shell.exit !== 0 ||
    shell.command !== intent.command
  )
    return INTENT_CHANGED
  const used = (yield* kvGet(db, keys.intent(sessionID))) as number | undefined
  if (intent.seq <= (used ?? 0)) return INTENT_USED
  yield* kvSet(db, keys.intent(sessionID), intent.seq)
  return undefined
})
const INTENT_USED = fail("intent_required", "That shell intent was already used; run it again for this operation")
const INTENT_CHANGED = fail("intent_required", "That shell intent changed before the operation; run it again")

/** Machine-checkable facts only. Semantic completeness and the meaning of prose grants stay with the reviewer. */
const check = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: string,
  state: StateInfo,
  coverage: CoverageInfo,
  optIn: boolean,
  now: number,
) {
  if (state.sessionID !== sessionID || state.owner.sessionID !== sessionID)
    return "The state belongs to another session"
  if (state.review.reviewedStateHash !== SessionStateEnvelope.reviewTargetHash(state))
    return "review.reviewedStateHash does not match the state"
  if (state.review.reviewerEvidence.length === 0) return "review.reviewerEvidence is required"
  if (state.review.completenessAttestation.trim() === "") return "review.completenessAttestation is required"
  const reviewed = Date.parse(state.review.reviewedAt)
  if (!(reviewed <= now) || new Date(reviewed).toISOString() !== state.review.reviewedAt)
    return "review.reviewedAt must be an ISO-8601 UTC time that is not in the future"
  if (canonical(state.review.currentThrough) !== canonical(coverage)) return "review.currentThrough is not the snapshot coverage"
  const duplicate = (ids: ReadonlyArray<string>) => new Set(ids).size !== ids.length
  if (duplicate(state.budgets.map((item) => item.id))) return "Duplicate budget ID"
  if (duplicate(state.unresolved.map((item) => item.id))) return "Duplicate unresolved ID"
  for (const list of [state.jobs, state.reminders])
    if (duplicate(list.flatMap((item) => (item.id.status === "unknown" ? [] : [item.id.value])))) return "Duplicate job or reminder ID"
  const facts = [state.pins.candidate, state.pins.deployed, state.pins.canonical, ...state.jobs.map((job) => job.id), ...state.reminders.map((item) => item.id)]
  if (facts.some((fact) => fact.status === "unknown" && fact.reason.trim() === "")) return "An unknown fact needs a reason"
  if (state.authority.some((item) => item.exactText.trim() === "")) return "Authority needs its exact text"
  for (const budget of state.budgets) {
    const values = [budget.allocation, budget.consumed, budget.remaining]
    if (values.some((value) => value !== "unknown" && !DECIMAL.test(value))) return `Budget ${budget.id} is not an exact decimal`
    if (budget.consumed === "unknown" && budget.remaining !== "unknown")
      return `Budget ${budget.id} has unknown consumption, so its remainder must be unknown`
    if (values.every((value) => value !== "unknown")) {
      const [allocation, consumed, remaining] = scaled(values)
      if (allocation - consumed !== remaining) return `Budget ${budget.id} does not add up`
    }
  }
  const lineage = yield* ancestors(db, sessionID)
  for (const ref of refsOf(state)) {
    if (ref.kind === "file") {
      if (!/^[0-9a-f]{64}$/.test(ref.sha256) || !ref.path.startsWith("/")) return `File evidence ${ref.path} needs an absolute path and SHA-256`
      continue
    }
    const own = ref.sessionID === sessionID
    if (!own && !lineage.includes(ref.sessionID)) return `Evidence ${ref.messageID} is outside this session's lineage`
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.id, ref.messageID as never), eq(SessionMessageTable.session_id, ref.sessionID as never)))
      .get()
      .pipe(Effect.orDie)
    if (!row || (own && row.seq > coverage.coveredSeq)) return `Evidence ${ref.messageID} is not in the covered history`
    if (ref.callID === undefined) continue
    const message = yield* decodeStoredRow((yield* withParts(db, [row]))[0]!).pipe(Effect.orDie)
    // A call reference names a settled tool call of exactly that assistant message.
    const settled =
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" && part.id === ref.callID && (part.state.status === "completed" || part.state.status === "error"),
      )
    if (!settled) return `Evidence ${ref.messageID} has no settled tool call ${ref.callID}`
  }
  if (!optIn) return undefined
  // A peer frame, an agent-written child prompt, a prompt copied into a fork or a stored claim cannot opt in.
  const session = yield* db
    .select({ fork: SessionTable.fork_session_id })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID as never))
    .get()
    .pipe(Effect.orDie)
  if (lineage.length > 0 || !session || session.fork) return "Only a root session that is not a fork can opt in"
  const grants = state.authority.filter(
    (item) => item.scope === OPT_IN_SCOPE && item.status === "active" && item.supersededBy === undefined,
  )
  for (const grant of grants) {
    if (grant.source.kind !== "message" || grant.source.sessionID !== sessionID) continue
    const row = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.id, grant.source.messageID as never), eq(SessionMessageTable.session_id, sessionID as never)))
      .get()
      .pipe(Effect.orDie)
    const message = row && (yield* decodeStoredRow(row).pipe(Effect.orDie))
    // Native provenance only: whether the prompt's words grant this remains the reviewed bootstrap's judgement.
    if (message && SessionReviewEvidence.originOf(message, true) === "root_human" && message.type === "user" && message.text === grant.exactText)
      return undefined
  }
  return `Opting in needs an active authority entry with scope "${OPT_IN_SCOPE}" quoting a whole human prompt in this session`
})

const unique = () => `scp_${crypto.randomUUID().replaceAll("-", "")}`

export const snapshot = Effect.fn("SessionStateCheckpoint.snapshot")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly source: Source },
): Effect.fn.Return<SnapshotResult> {
  if (!(yield* live(db, input.sessionID, input.source))) return fail("invalid_source", "Not a live controller_state call in this session")
  return yield* snapshotFrom(db, input)
})

const snapshotFrom = Effect.fnUntraced(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly source: Source },
  intent?: Intent & { readonly revision: number },
): Effect.fn.Return<SnapshotResult> {
  const now = yield* Clock.currentTimeMillis
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const measured = yield* measure(db, input.sessionID)
        if (!measured.ok) return measured
        const revision = (yield* current(db, input.sessionID))?.revision ?? 0
        if (intent && intent.revision !== revision) return fail("stale_revision", `Current revision is ${revision}`)
        const claimed = intent && (yield* claim(db, input.sessionID, intent))
        if (claimed) return claimed
        const id = unique()
        yield* kvSet(db, keys.snapshot(input.sessionID, id), {
          id,
          sessionID: input.sessionID,
          source: input.source,
          revision,
          coverage: measured.coverage,
          expires: now + SNAPSHOT_TTL,
        } satisfies Snapshot)
        return { ok: true as const, snapshotID: id, revision, coverage: measured.coverage }
      }),
    )
    .pipe(Effect.orDie)
})

export const read = Effect.fn("SessionStateCheckpoint.read")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly source: Source; readonly state?: boolean },
): Effect.fn.Return<({ readonly ok: true } & Status) | { readonly ok: false; readonly error: ErrorCode; readonly message: string }> {
  if (!(yield* live(db, input.sessionID, input.source))) return fail("invalid_source", "Not a live controller_state call in this session")
  const pointer = yield* current(db, input.sessionID)
  const outcome = (yield* kvGet(db, keys.outcome(input.sessionID))) as Outcome | undefined
  const version = pointer && input.state ? ((yield* kvGet(db, keys.version(input.sessionID, pointer.revision))) as Version) : undefined
  return {
    ok: true as const,
    ...(pointer ? { current: receipt(pointer) } : {}),
    ...(outcome ? { outcome } : {}),
    ...(version ? { state: version.state } : {}),
  }
})

const receipt = (pointer: Current): Receipt => ({
  revision: pointer.revision,
  stateHash: pointer.stateHash,
  enabled: pointer.enabled,
  coverage: pointer.coverage,
  expires: pointer.expires,
  ...(pointer.consumed ? { consumed: pointer.consumed } : {}),
})

/** Full-state replacement with CAS on `expectedRevision`; never a merge. */
export const update = Effect.fn("SessionStateCheckpoint.update")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly source: Source
    readonly expectedRevision: number
    readonly snapshotID: string
    readonly state: unknown
    readonly enabled: boolean
  },
): Effect.fn.Return<UpdateResult> {
  if (!(yield* live(db, input.sessionID, input.source))) return fail("invalid_source", "Not a live controller_state call in this session")
  return yield* updateFrom(db, input)
})

const updateFrom = Effect.fnUntraced(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly source: Source
    readonly expectedRevision: number
    readonly snapshotID: string
    readonly state: unknown
    readonly enabled: boolean
  },
  intent?: Intent,
): Effect.fn.Return<UpdateResult> {
  const now = yield* Clock.currentTimeMillis
  const decoded = SessionStateEnvelope.decodeState(input.state)
  if (Result.isFailure(decoded)) return fail("invalid_state", String(decoded.failure).slice(0, 2_000))
  const state = decoded.success as StateInfo
  const hash = SessionStateEnvelope.stateHash(state)
  if (Buffer.byteLength(render(state, input.expectedRevision + 1, hash)) > SessionStateEnvelope.BYTES)
    return fail("state_too_large", `The rendered checkpoint exceeds ${SessionStateEnvelope.BYTES} bytes; it is not trimmed or compacted`)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const pointer = yield* current(db, input.sessionID)
        const revision = pointer?.revision ?? 0
        if (input.expectedRevision !== revision) return fail("stale_revision", `Current revision is ${revision}`)
        const snap = (yield* kvGet(db, keys.snapshot(input.sessionID, input.snapshotID))) as Snapshot | undefined
        if (!snap || snap.sessionID !== input.sessionID || snap.used || snap.revision !== revision || now > snap.expires)
          return fail("snapshot_invalid", "Unknown, foreign, used, stale or expired snapshot")
        const changed = yield* verify(db, input.sessionID, snap.coverage)
        if (changed) return fail("coverage_changed", changed)
        const invalid = yield* check(db, input.sessionID, state, snap.coverage, input.enabled, now)
        if (invalid)
          return fail(invalid.startsWith("Opting") || invalid.startsWith("Only a root") ? "enable_unauthorised" : "invalid_state", invalid)
        const claimed = intent && (yield* claim(db, input.sessionID, intent))
        if (claimed) return claimed
        const next: Current = {
          revision: revision + 1,
          stateHash: hash,
          enabled: input.enabled,
          coverage: snap.coverage,
          expires: snap.expires,
          snapshotID: snap.id,
          sources: yield* sources(db, state),
        }
        yield* kvSet(db, keys.version(input.sessionID, next.revision), {
          revision: next.revision,
          stateHash: next.stateHash,
          state,
          source: input.source,
        } satisfies Version)
        yield* kvSet(db, keys.current(input.sessionID), next)
        yield* kvSet(db, keys.snapshot(input.sessionID, snap.id), { ...snap, used: true })
        return { ok: true as const, receipt: receipt(next) }
      }),
    )
    .pipe(Effect.orDie)
})

const armedError = (pointer: Current | undefined, revision: number) => {
  if (!pointer?.enabled) return fail("not_enabled", "Controller-state checkpoints are not enabled for this session")
  if (pointer.revision !== revision) return fail("stale_revision", `Current revision is ${pointer.revision}`)
  if (pointer.consumed) return fail("already_consumed", `Revision ${revision} was already checkpointed`)
  return undefined
}

const bindingError = (pointer: Current | undefined, bound: { readonly revision: number; readonly stateHash: string }) =>
  armedError(pointer, bound.revision) ??
  (pointer!.stateHash === bound.stateHash ? undefined : fail("stale_revision", "The state hash changed"))

/**
 * Commit of the checkpoint control's own `InboxEnqueued` event: the payload's binding must name the still-current,
 * unconsumed revision whose cited sources are unchanged, in the same transaction, so a failed check rejects the
 * admission too. A maintenance request claims its shell intent here.
 */
const bind = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID, bound: Binding, intent?: Intent) {
  const pointer = yield* current(db, sessionID)
  const error = bindingError(pointer, bound)
  if (error) return yield* Effect.die(new Blocked(error.error, error.message))
  const changed = yield* stale(db, sessionID, pointer!)
  if ("message" in changed) return yield* Effect.die(new Blocked("coverage_changed", changed.message))
  const claimed = intent && (yield* claim(db, sessionID, intent))
  if (claimed) return yield* Effect.die(new Blocked(claimed.error, claimed.message))
})

/**
 * Requests the native compaction control for the reviewed current revision. `admit` is `Session.compact`; a
 * different pending compaction is a conflict, never adopted as this request, and a same-ID retry must carry this
 * exact durable binding.
 */
type Admit = (input: {
  readonly sessionID: SessionSchema.ID
  readonly id: SessionMessage.ID
  readonly checkpoint: Binding
  readonly commit: () => Effect.Effect<void>
}) => Effect.Effect<SessionInbox.Info, NotFoundError | CompactionConflictError>

export const compact = Effect.fn("SessionStateCheckpoint.compact")(function* (
  db: DatabaseService,
  admit: Admit,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly source: Source
    readonly expectedRevision: number
    readonly requestID?: string
  },
): Effect.fn.Return<CompactResult> {
  if (!(yield* live(db, input.sessionID, input.source))) return fail("invalid_source", "Not a live controller_state call in this session")
  return yield* compactFrom(db, admit, input)
})

const compactFrom = Effect.fnUntraced(function* (
  db: DatabaseService,
  admit: Admit,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly expectedRevision: number
    readonly requestID?: string
    readonly maintenance?: boolean
  },
  intent?: Intent,
): Effect.fn.Return<CompactResult> {
  if (input.requestID !== undefined && !Schema.is(SessionMessage.ID)(input.requestID))
    return fail("invalid_source", "requestID must be a message ID")
  const pointer = yield* current(db, input.sessionID)
  const armed = armedError(pointer, input.expectedRevision)
  if (armed) return armed
  if ((yield* Clock.currentTimeMillis) > pointer!.expires) return fail("expired", "The reviewed revision expired; take a new snapshot")
  const changed = yield* verify(db, input.sessionID, pointer!.coverage)
  if (changed) return fail("coverage_changed", changed)
  const cited = yield* stale(db, input.sessionID, pointer!)
  if ("message" in cited) return fail("coverage_changed", cited.message)
  const bound: Binding = {
    version: 1,
    sessionID: input.sessionID,
    revision: pointer!.revision,
    stateHash: pointer!.stateHash,
    ...(input.maintenance ? { maintenance: true as const } : {}),
  }
  const id = (input.requestID as SessionMessage.ID | undefined) ?? SessionMessage.ID.create()
  const conflict = fail("compaction_pending", "Another compaction is pending, or this request ID is bound to another revision")
  return yield* admit({ sessionID: input.sessionID, id, checkpoint: bound, commit: () => bind(db, input.sessionID, bound, intent) }).pipe(
    // A same-ID retry returns the stored control without committing again: it must carry this exact binding.
    Effect.map((item) =>
      item.type === "compaction" && canonical(item.payload.checkpoint) === canonical(bound)
        ? { ok: true as const, requestID: id, revision: bound.revision, stateHash: bound.stateHash }
        : conflict,
    ),
    Effect.catchTag("Session.CompactionConflictError", () => Effect.succeed(conflict)),
    Effect.catchTag("Session.NotFoundError", () => Effect.succeed(fail("invalid_source", "Session not found"))),
    Effect.catchDefect((defect) =>
      defect instanceof Blocked ? Effect.succeed(fail(defect.code, defect.message)) : Effect.die(defect),
    ),
  )
})

export type Operation = MaintainInput["operation"]

/** The native shell intent a maintenance operation needs: a shell comment, so running it changes nothing. */
export const intent = (operation: Operation, revision: number, hash?: string) =>
  `# controller-state ${operation} revision=${revision}${hash === undefined ? "" : ` sha256=${hash}`}`

/**
 * Operator maintenance while the context budget blocks the selected model, so no live tool call can exist. It never
 * enables checkpoints or touches the budget: the session must already be opted in and actually blocked. Each call
 * consumes one fresh native shell intent naming exactly this operation, revision and hash; that is native API origin,
 * not cryptographic proof of a human. Snapshot, update and compact then apply every ordinary check.
 */
export const maintain = Effect.fn("SessionStateCheckpoint.maintain")(function* (
  db: DatabaseService,
  session: SessionSchema.Info,
  admit: Admit,
  input: MaintainInput,
): Effect.fn.Return<MaintainResult> {
  const sessionID = session.id
  const pointer = yield* current(db, sessionID)
  if (!pointer?.enabled) return fail("not_enabled", "Controller-state checkpoints are not enabled for this session")
  if (session.parentID || session.fork) return fail("maintenance_unavailable", "Only a root session that is not a fork has maintenance")
  const blocked = session.contextBudgetState?.blocked
  if (!blocked || blocked.selection !== SessionContextBudget.selection(session))
    return fail("maintenance_unavailable", "Maintenance is only for a session whose context budget blocks its selected model")
  if (input.expectedRevision !== pointer.revision) return fail("stale_revision", `Current revision is ${pointer.revision}`)
  const decoded = input.operation === "update" ? SessionStateEnvelope.decodeState(input.state) : undefined
  if (decoded && Result.isFailure(decoded)) return fail("invalid_state", String(decoded.failure).slice(0, 2_000))
  const hash = decoded ? SessionStateEnvelope.stateHash(decoded.success as StateInfo) : input.operation === "compact" ? pointer.stateHash : undefined
  const expected = intent(input.operation, pointer.revision, hash)
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "shell")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const shell = row && (yield* decodeStoredRow(row).pipe(Effect.orDie))
  const used = (yield* kvGet(db, keys.intent(sessionID))) as number | undefined
  const required = { ...fail("intent_required", `Run this exact shell command in this session first: ${expected}`), intent: expected }
  if (!row || shell?.type !== "shell" || shell.status !== "exited" || shell.exit !== 0 || shell.command !== expected || row.seq <= (used ?? 0))
    return required
  // The operation re-reads and claims this exact shell row inside its own transaction, against the revision and hash
  // it names; a claim that loses a race or finds the row changed, or whose transaction fails, leaves the operation
  // undone. Its success is never replayed.
  const authorised: Intent = { seq: row.seq, messageID: row.id, shellID: shell.shellID, command: expected }
  const source = { messageID: row.id, callID: shell.shellID }
  const result: MaintainResult =
    input.operation === "snapshot"
      ? yield* snapshotFrom(db, { sessionID, source }, { ...authorised, revision: input.expectedRevision })
      : input.operation === "update"
        ? yield* updateFrom(
            db,
            {
              sessionID,
              source,
              expectedRevision: input.expectedRevision,
              snapshotID: input.snapshotID ?? "",
              state: input.state,
              enabled: true,
            },
            authorised,
          )
        : yield* compactFrom(
            db,
            admit,
            { sessionID, expectedRevision: input.expectedRevision, requestID: input.requestID, maintenance: true },
            authorised,
          )
  return !result.ok && result.error === "intent_required" ? { ...result, intent: expected } : result
})

/** The plugin host's `stateCheckpoint.maintain`: resolves the session the command runs in, then `maintain`. */
export const maintainFor = (
  db: DatabaseService,
  sessions: {
    readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
    readonly compact: Admit
  },
  input: MaintainInput,
) =>
  sessions.get(input.sessionID as SessionSchema.ID).pipe(
    Effect.flatMap((session) => maintain(db, session, sessions.compact, input)),
    Effect.catchTag("Session.NotFoundError", () => Effect.succeed(fail("invalid_source", "Session not found"))),
  )

/** The receipt, its immutable version and its rendering, re-validated together; any mismatch is a reason. */
const loadBound = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  bound: { readonly revision: number; readonly stateHash: string },
) {
  const pointer = yield* current(db, sessionID)
  if (!pointer)
    return "Recovery required: a durable controller-state checkpoint or control has no local receipt; only a fresh reviewed update re-establishes it"
  const error = bindingError(pointer, bound)
  if (error) return error.message
  if ((yield* Clock.currentTimeMillis) > pointer.expires) return "The reviewed revision expired; take a new snapshot"
  const version = yield* stale(db, sessionID, pointer)
  if ("message" in version) return version.message
  return { pointer, rendered: render(version.state, bound.revision, bound.stateHash) }
})

/**
 * Loads what a checkpoint will commit: a manual control's exact durable binding, otherwise the armed current
 * revision, with its coverage and deterministic rendering. Anything else is a blocked result.
 */
export const prepare = Effect.fn("SessionStateCheckpoint.prepare")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  trigger: { readonly manual: boolean; readonly bound?: Binding },
): Effect.fn.Return<{ readonly ok: true; readonly binding: CheckpointBinding } | { readonly ok: false; readonly message: string }> {
  const pointer = yield* current(db, sessionID)
  if (trigger.manual && !trigger.bound && pointer)
    return { ok: false as const, message: "A plain compaction control cannot checkpoint this session; request it through controller_state" }
  if (trigger.bound && trigger.bound.sessionID !== sessionID)
    return { ok: false as const, message: "The control is bound to another session" }
  const bound = trigger.bound ?? (pointer ? { revision: pointer.revision, stateHash: pointer.stateHash } : { revision: 0, stateHash: "" })
  const loaded = yield* loadBound(db, sessionID, bound)
  if (typeof loaded === "string") return { ok: false as const, message: loaded }
  const changed = yield* verify(db, sessionID, loaded.pointer.coverage)
  if (changed) return { ok: false as const, message: changed }
  return {
    ok: true as const,
    binding: { revision: bound.revision, stateHash: bound.stateHash, coverage: loaded.pointer.coverage, rendered: loaded.rendered },
  }
})

/** The running compaction message a checkpoint completes, as the native projector selects it. */
export const running = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.id),
    )

/**
 * Runs inside the native `Compaction.Ended` transaction, after projection: re-validates the core-owned binding, its
 * stored state and coverage against exactly the checkpoint message this event completed, then consumes the revision.
 * Failure rolls the whole checkpoint back.
 */
export const commit = Effect.fn("SessionStateCheckpoint.commit")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  checkpoint: CheckpointBinding,
  requestID: string,
  messageID: string,
  eventSeq: number,
) {
  const loaded = yield* loadBound(db, sessionID, checkpoint)
  if (typeof loaded === "string") return yield* Effect.die(new Blocked("coverage_changed", loaded))
  if (loaded.rendered !== checkpoint.rendered || canonical(loaded.pointer.coverage) !== canonical(checkpoint.coverage))
    return yield* Effect.die(new Blocked("coverage_changed", "The checkpoint does not match its receipt"))
  const changed = yield* verify(db, sessionID, checkpoint.coverage, { ...checkpoint, id: messageID })
  if (changed) return yield* Effect.die(new Blocked("coverage_changed", changed))
  const row = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID as SessionMessage.ID)))
    .get()
    .pipe(Effect.orDie)
  yield* kvSet(db, keys.current(sessionID), {
    ...loaded.pointer,
    consumed: { requestID, messageID, messageSeq: row!.seq, eventSeq },
  } satisfies Current)
  yield* kvSet(db, keys.outcome(sessionID), { requestID, status: "completed", message: `Checkpointed revision ${checkpoint.revision}` } satisfies Outcome)
})

/**
 * Whether a maintenance checkpoint still holds the session idle: only native controls run, and inputs queued before
 * it stay pending, across coalesced wakes, settlement and restart recovery. It is derived from durable native facts,
 * so an event-only replica holds too: the latest completed compaction is a maintenance-bound checkpoint, no user
 * prompt was admitted or recorded after it, and no explicit resume released it.
 */
export const held = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const latest = yield* latestCompleted(db, sessionID)
  const binding = latest && (yield* checkpointBinding(db, sessionID, latest.id))
  // Invalid native provenance is recovery-only, even after an explicit resume or a later prompt.
  if (binding === false) return true
  if (!latest || !binding || !binding.maintenance) return false
  if ((yield* kvGet(db, keys.released(sessionID))) === latest.id) return false
  const recorded = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), gt(SessionMessageTable.seq, latest.seq)))
    .get()
    .pipe(Effect.orDie)
  if (recorded) return false
  const admitted = yield* db
    .select({ id: SessionInboxTable.id })
    .from(SessionInboxTable)
    .where(and(eq(SessionInboxTable.session_id, sessionID), eq(SessionInboxTable.type, "user"), gt(SessionInboxTable.enqueued_seq, latest.seq)))
    .get()
    .pipe(Effect.orDie)
  return !admitted
})

/** An explicit resume releases the current maintenance hold. */
export const release = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const latest = yield* latestCompleted(db, sessionID)
  if (latest) yield* kvSet(db, keys.released(sessionID), latest.id)
})

/** The original typed messages after the covered prefix, in native order, without compaction markers. */
export const tail = (db: DatabaseService, sessionID: SessionSchema.ID, coveredSeq: number) =>
  db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), gt(SessionMessageTable.seq, coveredSeq)))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.flatMap((rows) => decodeMessageRows(db, rows)),
      Effect.map((messages) => messages.filter((message) => message.type !== "compaction")),
      Effect.orDie,
    )

/** Durable, inspectable record of a blocked checkpoint; it never consumes the revision. */
export const blocked = (db: DatabaseService, sessionID: SessionSchema.ID, requestID: string, message: string) =>
  kvSet(db, keys.outcome(sessionID), { requestID, status: "blocked", message } satisfies Outcome)
