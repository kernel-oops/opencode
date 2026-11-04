import { expect } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, type LLMRequest } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import type { CheckpointBinding, State } from "@opencode/plugin/controller-state"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { KVTable } from "@opencode/core/kv/sql"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { Instructions } from "@opencode/core/instructions/index"
import { CompactionConflictError } from "@opencode/core/session/error"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionBlob } from "@opencode/core/session/blob"
import { SessionStored } from "@opencode/core/session/stored"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { BlobTable, InstructionStateTable, SessionMessageTable, SessionPartTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStateCheckpoint } from "@opencode/core/session/state-checkpoint"
import { SessionStateEnvelope } from "@opencode/core/session/state-envelope"
import { SessionStore } from "@opencode/core/session/store"
import { Session } from "@opencode/core/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Agent } from "@opencode/core/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { DateTime, Deferred, Effect, Exit, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { and, asc, eq, gte, like } from "drizzle-orm"
import { testEffect } from "./lib/effect"

/**
 * Every model request in this harness, of any kind (primary, compaction, title, generate or helper), reaches this
 * one client: `stream` records it and `generate` dies. A checkpoint must leave it empty.
 */
let requests: LLMRequest[] = []
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "## Objective\n- model summary" }),
      LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" }, usage: { inputTokens: 10, outputTokens: 5 } }),
      LLMEvent.finish({ reason: { normalized: "stop" } }),
    )
  },
  generate: () => Effect.die("A state checkpoint must not generate"),
})
const resolved = SessionRunnerModel.resolved(LanguageModel.make({ id: "summary-model", provider: "test", route: OpenAIChat.route }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionInbox.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      SessionRunnerModel.node.replace(Layer.mock(SessionRunnerModel.Service)({ resolve: () => Effect.succeed(resolved) })),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const GRANT = "Use controller-state checkpoints for this session."
const LONG = "exact tail ".repeat(500)
const policy = { target: 150_000, maximum: 180_000 }
/** The test clock starts at the epoch; jumping it decades ahead would replay every periodic timer. */
const LATCH = { attempted: { binding: "fixture", estimated: 1 } }

const user = (text: string) =>
  SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text, time: { created: DateTime.makeUnsafe(0) } })
const assistant = (content: unknown[], completed = true, id = SessionMessage.ID.create()) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id,
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "summary-model", providerID: "test" },
    content,
    time: completed ? { created: 0, completed: 0 } : { created: 0 },
  })
const text = (value: string) => ({ type: "text", text: value })
const call = (id: string, name: string, state: unknown) => ({ type: "tool", id, name, state, time: { created: 0 } })
const running = { status: "running", input: {}, metadata: {} }
const done = (output: string) => ({ status: "completed", input: {}, content: [{ type: "text", text: output }] })

const insertSession = (id: Session.ID, overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: id, version: "test", ...overrides })
      .run()
      .pipe(Effect.orDie)
  })

const row = (sessionID: Session.ID, message: SessionMessage.Info, seq: number) => {
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(message)
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, time_created: 0, data }
}
/** Appends original messages after whatever the session already holds. */
const append = (sessionID: Session.ID, messages: readonly SessionMessage.Info[]) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const last = yield* db
      .select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const start = (last?.seq ?? 0) + 1
    yield* db
      .insert(SessionMessageTable)
      .values(messages.map((message, index) => row(sessionID, message, start + index)))
      .run()
      .pipe(Effect.orDie)
    yield* Bus.reserveSequence(db, sessionID, start + messages.length - 1)
  })
/** Settles a stored message in place, as the native runner does when a tool call finishes. */
const replace = (sessionID: Session.ID, message: SessionMessage.Info) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .update(SessionMessageTable)
      .set({ data: row(sessionID, message, 0).data })
      .where(eq(SessionMessageTable.id, message.id))
      .run()
      .pipe(Effect.orDie)
  })

const fact = { status: "unknown" as const, reason: "Not recorded in this fixture", evidence: [] }
/** A reviewed full state; its hash is over everything except the review envelope. */
const reviewed = (
  sessionID: Session.ID,
  coverage: State["review"]["currentThrough"],
  evidence: { readonly sessionID: string; readonly messageID: string },
  overrides: Partial<State> = {},
): State => {
  const state: State = {
    version: 1,
    sessionID,
    owner: { sessionID, workdir: "/project" },
    authority: [],
    budgets: [],
    pins: { candidate: fact, deployed: fact, canonical: fact },
    jobs: [],
    reminders: [],
    unresolved: [],
    evidence: [],
    ...overrides,
    review: {
      reviewedStateHash: "",
      reviewerEvidence: [{ kind: "message", ...evidence }],
      reviewedAt: "1970-01-01T00:00:00.000Z",
      completenessAttestation: "Synthetic fixture",
      currentThrough: coverage,
    },
  }
  return { ...state, review: { ...state.review, reviewedStateHash: SessionStateEnvelope.reviewTargetHash(state) } }
}

const loaded = (session: Session.Info, messages: readonly SessionMessage.Info[]) => ({
  session,
  messages,
  model: resolved,
  agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
  initial: [{ key: Instructions.Key.make("test/session"), text: "Session instructions" }],
  tools: { definitions: [], execute: () => Effect.die("Compaction must not execute tools") },
})

/**
 * A root session with an explicit human opt-in, a long covered exchange and a running `controller_state` call.
 * Returns the reviewed, enabled revision 1.
 */
const armed = Effect.fnUntraced(function* (
  sessionID: Session.ID,
  options: { readonly budget?: boolean; readonly enable?: boolean; readonly latch?: boolean } = {},
) {
  const db = (yield* Database.Service).db
  yield* insertSession(sessionID, {
    ...(options.budget === false ? {} : { context_budget: policy }),
    ...(options.latch ? { context_budget_state: LATCH } : {}),
  })
  if (options.latch)
    yield* db
      .insert(InstructionStateTable)
      .values({ session_id: sessionID, epoch_start: 0, through_seq: 0, initial_values: {} as never, current_values: {} as never })
      .run()
      .pipe(Effect.orDie)
  const grant = user(GRANT)
  const answer = assistant([text("Noted.")])
  const covered = user(`Covered ${LONG}`)
  const read = assistant([call("call_read", "read", done("read")), text("Done.")])
  const tool = assistant([call("call_state", "controller_state", running)], false)
  yield* append(sessionID, [grant, answer, covered, read, tool])
  const source = { messageID: tool.id, callID: "call_state" }
  const snap = yield* SessionStateCheckpoint.snapshot(db, { sessionID, source })
  if (!snap.ok) return yield* Effect.die(snap)
  const state = reviewed(sessionID, snap.coverage, { sessionID, messageID: answer.id }, {
    authority: [
      {
        source: { kind: "message", sessionID, messageID: grant.id },
        exactText: GRANT,
        scope: SessionStateCheckpoint.OPT_IN_SCOPE,
        status: "active",
        negativeConstraints: ["No activation, provider or production access"],
      },
    ],
  })
  const updated = yield* SessionStateCheckpoint.update(db, {
    sessionID,
    source,
    expectedRevision: 0,
    snapshotID: snap.snapshotID,
    state,
    enabled: options.enable ?? true,
  })
  return { db, grant, answer, covered, read, tool, source, snap, state, updated }
})

/** The plugin's half: echo exactly the rendering core supplies, and nothing for ordinary compactions. */
const echo = Effect.fnUntraced(function* (seen: CheckpointBinding[]) {
  const hooks = yield* PluginHooks.Service
  yield* hooks.register("session", "compaction", (event) =>
    Effect.sync(() => {
      const checkpoint = (event as { readonly checkpoint?: CheckpointBinding }).checkpoint
      if (!checkpoint) return
      seen.push(checkpoint)
      event.result = { summary: checkpoint.rendered }
    }),
  )
})

const inboxAdmit = Effect.fnUntraced(function* () {
  const inbox = yield* SessionInbox.Service
  return (input: {
    readonly sessionID: Session.ID
    readonly id: SessionMessage.ID
    readonly checkpoint: SessionStateCheckpoint.Binding
    readonly commit: () => Effect.Effect<void>
  }) =>
    inbox
      .admitCompaction({ ...input, delivery: "steer" })
      .pipe(
        // As `Session.compact` maps it.
        Effect.catchTag("SessionInbox.LifecycleConflict", () =>
          Effect.fail(new CompactionConflictError({ sessionID: input.sessionID, inputID: input.id })),
        ),
      )
})

/** Delivers a `/compact` control as the runner does: its durable payload binding travels with the trigger. */
const manual = (session: Session.Info, messages: readonly SessionMessage.Info[], inputID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const compaction = yield* SessionCompaction.Service
    const db = (yield* Database.Service).db
    const item = (yield* SessionInbox.list(db, session.id)).find((pending) => pending.id === inputID)
    const checkpoint = item?.type === "compaction" ? item.payload.checkpoint : undefined
    const started = [SessionEvent.Compaction.Started, { sessionID: session.id, reason: "manual", inputID }] as const
    if (item) yield* bus.publishAll([[SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: inputID }], started])
    if (!item) yield* bus.publishAll([started])
    return yield* compaction.compact({ reason: "manual", context: loaded(session, messages), inputID, checkpoint })
  })

const session = (id: Session.ID) =>
  SessionStore.Service.pipe(
    Effect.flatMap((store) => store.get(id)),
    Effect.flatMap((found) => (found ? Effect.succeed(found) : Effect.die(`session missing: ${id}`))),
  )

const eventTypes = (sessionID: Session.ID) =>
  Database.Service.pipe(
    Effect.flatMap(({ db }) =>
      db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ),
    Effect.map((rows) => rows.map((item) => item.type)),
  )
const STARTED = Bus.versionedType(SessionEvent.Compaction.Started.type, 1)
const ENDED = Bus.versionedType(SessionEvent.Compaction.Ended.type, 1)
const FAILED = Bus.versionedType(SessionEvent.Compaction.Failed.type, 1)
const ENQUEUED = Bus.versionedType(SessionEvent.InboxEnqueued.type, 1)
const DELIVERED = Bus.versionedType(SessionEvent.InboxDelivered.type, 1)

/** Completes the requesting tool call and a later arrival, then delivers the bound control as the runner does. */
const deliver = Effect.fnUntraced(function* (sessionID: Session.ID, fixture: Effect.Success<ReturnType<typeof armed>>, requestID: SessionMessage.ID) {
  const settled = assistant([call("call_state", "controller_state", done(`Bound ${LONG}`))], true, fixture.tool.id)
  yield* replace(sessionID, settled)
  const later = user(`Arrived before the marker ${LONG}`)
  yield* append(sessionID, [later])
  return { settled, later, outcome: yield* manual(yield* session(sessionID), [], requestID) }
})

/** Every compaction row of a session, in sequence order. */
const compactionRows = (sessionID: Session.ID) =>
  Database.Service.pipe(
    Effect.flatMap(({ db }) =>
      db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie),
    ),
  )

/** Requests the bound control for the current revision as the plugin tool does. */
const request = (fixture: { readonly db: Database.Interface["db"]; readonly source: { messageID: string; callID: string } }, sessionID: Session.ID, expectedRevision = 1) =>
  Effect.gen(function* () {
    const requested = yield* SessionStateCheckpoint.compact(fixture.db, yield* inboxAdmit(), {
      sessionID,
      source: fixture.source,
      expectedRevision,
    })
    if (!requested.ok) return yield* Effect.die(requested)
    return requested.requestID as SessionMessage.ID
  })

const statusOf = (db: Database.Interface["db"], sessionID: Session.ID) =>
  Effect.gen(function* () {
    // A fresh live call: status is only readable from a running controller_state call.
    const probe = assistant([call("call_probe", "controller_state", running)], false)
    yield* append(sessionID, [probe])
    return yield* SessionStateCheckpoint.read(db, { sessionID, source: { messageID: probe.id, callID: "call_probe" } })
  })

it.effect("an opted-in manual checkpoint commits the reviewed state with no model call and keeps the exact typed tail", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_manual")
    const fixture = yield* armed(sessionID)
    expect(fixture.updated).toMatchObject({ ok: true, receipt: { revision: 1, enabled: true } })
    expect(fixture.snap.ok && fixture.snap.coverage).toMatchObject({ checkpointSeq: 0, fromSeq: 0, coveredSeq: 4 })
    const seen: CheckpointBinding[] = []
    yield* echo(seen)
    const requestID = yield* request(fixture, sessionID)
    const pending = (yield* SessionInbox.list(fixture.db, sessionID)).find((item) => item.id === requestID)
    const hash = SessionStateEnvelope.stateHash(fixture.state)
    expect(pending?.payload).toEqual({ checkpoint: { version: 1, sessionID, revision: 1, stateHash: hash } })
    const { settled, later, outcome } = yield* deliver(sessionID, fixture, requestID)
    expect(outcome).toEqual({ status: "completed" })
    const after = user(`Arrived after the marker ${LONG}`)
    yield* append(sessionID, [after])

    expect(requests).toEqual([])
    expect(seen).toHaveLength(1)
    const rendered = SessionStateEnvelope.render(fixture.state, 1, hash)
    expect(seen[0]?.rendered).toBe(rendered)
    const history = yield* SessionHistory.load(fixture.db, sessionID, "local")
    expect(history[0]).toMatchObject({ type: "compaction", status: "completed", summary: rendered })
    // The original typed messages after the covered prefix, unclipped (each well over 1,250 characters).
    expect(history.slice(1)).toEqual([settled, later, after])
    expect(JSON.stringify(history)).not.toContain(fixture.covered.text)
    // The durable envelope alone decodes to the committed state, revision and coverage.
    expect(SessionStateEnvelope.decode(rendered, { sessionID, revision: 1, stateHash: hash })).toEqual({ state: fixture.state, revision: 1, stateHash: hash, coverage: fixture.state.review.currentThrough })
    // The consumed receipt names the checkpoint message and its row, separate from the Ended event.
    const [marker] = yield* compactionRows(sessionID)
    const ended = yield* fixture.db
      .select({ seq: EventTable.seq })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, ENDED)))
      .get()
      .pipe(Effect.orDie)
    const status = yield* statusOf(fixture.db, sessionID)
    expect(status).toMatchObject({
      ok: true,
      current: { revision: 1, consumed: { requestID, messageID: marker?.id, messageSeq: marker?.seq, eventSeq: ended?.seq } },
    })
    expect(marker?.seq).not.toBe(ended?.seq)
    expect(yield* eventTypes(sessionID)).toEqual([ENQUEUED, DELIVERED, STARTED, ENDED])
    // The requesting call has finished, so it is no longer a live source.
    expect(yield* SessionStateCheckpoint.compact(fixture.db, yield* inboxAdmit(), { sessionID, source: fixture.source, expectedRevision: 1 })).toMatchObject({
      ok: false,
      error: "invalid_source",
    })
  }),
)

it.effect("blob-backed user grants and retained attachments survive a reviewed checkpoint", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_blob")
    const fixture = yield* armed(sessionID, { enable: false })
    const bytes = Buffer.from("Exact attachment bytes")
    const hash = SessionBlob.hashBytes(bytes)
    const file = SessionStored.FileRef.make({ uri: SessionStored.ref(hash), mime: "text/plain", source: { type: "inline" }, name: "proof.txt" })
    yield* fixture.db.insert(BlobTable).values({ hash, mime: file.mime, bytes: bytes.length, data: bytes }).run().pipe(Effect.orDie)
    const attach = (message: SessionMessage.User) => fixture.db.update(SessionMessageTable)
      .set({ data: { ...row(sessionID, message, 0).data, files: [file] } })
      .where(eq(SessionMessageTable.id, message.id)).run().pipe(Effect.orDie)
    yield* attach(fixture.grant)
    const snap = yield* SessionStateCheckpoint.snapshot(fixture.db, { sessionID, source: fixture.source })
    if (!snap.ok) return yield* Effect.die(snap)
    const state = reviewed(sessionID, snap.coverage, { sessionID, messageID: fixture.answer.id }, { authority: fixture.state.authority })
    expect(yield* SessionStateCheckpoint.update(fixture.db, { sessionID, source: fixture.source, expectedRevision: 1, snapshotID: snap.snapshotID, state, enabled: true }))
      .toMatchObject({ ok: true, receipt: { revision: 2, enabled: true } })
    const retained = user("Retain this attachment")
    yield* append(sessionID, [retained])
    yield* attach(retained)
    yield* echo([])
    const requestID = yield* request(fixture, sessionID, 2)
    expect((yield* deliver(sessionID, fixture, requestID)).outcome).toEqual({ status: "completed" })
    const history = yield* SessionHistory.load(fixture.db, sessionID, "local")
    expect(history.find((message) => message.id === retained.id)).toMatchObject({ files: [{ data: bytes.toString("base64"), name: file.name }] })
    const tool = assistant([call("blob-result", "read", { status: "completed", input: {}, content: [{ type: "file", uri: file.uri, mime: file.mime, name: file.name }] })])
    yield* append(sessionID, [tool])
    const tail = yield* SessionStateCheckpoint.tail(fixture.db, sessionID, snap.coverage.coveredSeq)
    expect(tail.find((message) => message.id === retained.id)).toMatchObject({ files: [{ data: bytes.toString("base64"), name: file.name }] })
    expect(tail.find((message) => message.id === tool.id)).toMatchObject({ content: [{ state: { content: [{ uri: `data:${file.mime};base64,${bytes.toString("base64")}` }] } }] })
    expect(requests).toEqual([])
  }),
)

it.effect("a checkpoint keeps pre-marker instruction synthetics in its deduplication window", () =>
  Effect.gen(function* () {
    const sessionID = Session.ID.make("ses_state_synthetics")
    const fixture = yield* armed(sessionID)
    const retained = SessionMessage.Synthetic.make({ id: SessionMessage.ID.create(), type: "synthetic", text: "Already injected instruction", time: { created: DateTime.makeUnsafe(0) } })
    yield* append(sessionID, [retained])
    yield* echo([])
    const requestID = yield* request(fixture, sessionID)
    expect((yield* deliver(sessionID, fixture, requestID)).outcome).toEqual({ status: "completed" })
    expect(yield* SessionHistory.synthetics(fixture.db, sessionID)).toEqual([retained])
  }),
)

it.effect("every trigger of an opted-in session routes to the checkpoint, never a summary model", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    yield* echo([])
    for (const reason of ["overflow", "budget"] as const) {
      const sessionID = Session.ID.make(`ses_state_${reason}`)
      const fixture = yield* armed(sessionID, { latch: true })
      const outcome = yield* compaction.compact({ reason, context: loaded(yield* session(sessionID), []) })
      expect(outcome).toEqual({ status: "completed" })
      const status = yield* statusOf(fixture.db, sessionID)
      expect(status).toMatchObject({ ok: true, current: { revision: 1, consumed: { requestID: reason } }, outcome: { status: "completed" } })
      // An automatic checkpoint advances the instruction epoch to its own commit, like any compaction.
      const epoch = yield* fixture.db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).get().pipe(Effect.orDie)
      const [marker] = yield* compactionRows(sessionID)
      expect(epoch?.epoch_start).toBeGreaterThan(marker!.seq)
      // The checkpoint message carries core's provenance, so it stays recognised once the local receipt is gone.
      expect(yield* eventTypes(sessionID)).toEqual([STARTED, ENDED])
      expect(marker!.data).toMatchObject({ checkpoint: { version: 1, sessionID, revision: 1, stateHash: fixture.updated.ok ? fixture.updated.receipt.stateHash : "" } })
      yield* fixture.db.delete(KVTable).where(like(KVTable.key, `session/state-checkpoint/${sessionID}/%`)).run().pipe(Effect.orDie)
      expect(yield* SessionStateCheckpoint.engaged(fixture.db, sessionID)).toBe(true)
      const history = yield* SessionHistory.load(fixture.db, sessionID, "local")
      expect(history[0]).toMatchObject({ type: "compaction", status: "completed", summary: expect.stringContaining("<controller-state version=\"1\"") })
      expect(yield* SessionInbox.list(fixture.db, sessionID)).toEqual([])
    }
    expect(requests).toEqual([])
  }),
)

it.effect("a missing, different or forged hook result, a missing budget policy or a tampered state blocks without fallback", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const hooks = yield* PluginHooks.Service
    const blockedWith = Effect.fnUntraced(function* (sessionID: Session.ID, fragment: string) {
      const db = (yield* Database.Service).db
      const outcome = yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(sessionID), []) })
      expect(outcome).toMatchObject({ status: "failed", error: { type: "state-checkpoint.blocked" } })
      const events = yield* eventTypes(sessionID)
      expect(events.slice(-2)).toEqual([STARTED, FAILED])
      expect(events).not.toContain(ENDED)
      const status = yield* statusOf(db, sessionID)
      expect(status).toMatchObject({ ok: true, outcome: { status: "blocked" } })
      expect(status.ok && status.current?.consumed).toBeUndefined()
      expect(status.ok && status.outcome?.message).toContain(fragment)
      const history = yield* SessionHistory.load(db, sessionID, "local")
      expect(history.some((message) => message.type === "compaction" && message.status === "completed")).toBe(false)
    })

    yield* armed(Session.ID.make("ses_state_unhooked"))
    yield* blockedWith(Session.ID.make("ses_state_unhooked"), "No compaction hook")

    yield* armed(Session.ID.make("ses_state_nobudget"), { budget: false })
    yield* blockedWith(Session.ID.make("ses_state_nobudget"), "context budget policy")

    const tampered = yield* armed(Session.ID.make("ses_state_tampered"))
    yield* tampered.db
      .update(KVTable)
      .set({ value: { revision: 1, stateHash: "0".repeat(64), state: { ...tampered.state, authority: [] }, source: tampered.source } as never })
      .where(eq(KVTable.key, "session/state-checkpoint/ses_state_tampered/version/0000000001"))
      .run()
      .pipe(Effect.orDie)
    const seen: CheckpointBinding[] = []
    yield* echo(seen)
    yield* blockedWith(Session.ID.make("ses_state_tampered"), "does not match its receipt")

    // A hook that rewrites its copy of the binding and returns that rendering: core compares its own binding.
    yield* armed(Session.ID.make("ses_state_forged"))
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        const copy = (event as { readonly checkpoint?: CheckpointBinding }).checkpoint as
          | { revision: number; stateHash: string; rendered: string; coverage: { userAdmission: number; coveredSeq: number } }
          | undefined
        if (!copy) return
        copy.revision = 9
        copy.stateHash = "f".repeat(64)
        copy.coverage.userAdmission = 99
        copy.coverage.coveredSeq = 99
        copy.rendered = copy.rendered.replace("Synthetic fixture", "Forged fixture")
        event.result = { summary: copy.rendered }
      }),
    )
    yield* blockedWith(Session.ID.make("ses_state_forged"), "No compaction hook")

    yield* armed(Session.ID.make("ses_state_different"))
    yield* hooks.register("session", "compaction", (event) => Effect.sync(() => void (event.result = { summary: "a model-free paraphrase" })))
    yield* blockedWith(Session.ID.make("ses_state_different"), "No compaction hook")

    // Hooks share one detached copy per event; the forging hook rewrote it, and core still blocked.
    expect(seen).toHaveLength(2)
    expect(requests).toEqual([])
  }),
)

it.effect("a hook defect fails the checkpoint without a summary fallback", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_defect")
    const fixture = yield* armed(sessionID)
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    yield* hooks.register("session", "compaction", () => Effect.die("hook defect"))
    const exit = yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(sessionID), []) }).pipe(Effect.exit)
    // Either the defect propagates or the hook is isolated and the missing result blocks; never a model summary.
    expect(Exit.isFailure(exit) || (Exit.isSuccess(exit) && exit.value.status === "failed")).toBe(true)
    expect(requests).toEqual([])
    expect((yield* compactionRows(sessionID)).map((item) => (item.data as { status: string }).status)).not.toContain("completed")
    const status = yield* statusOf(fixture.db, sessionID)
    expect(status.ok && status.current?.consumed).toBeUndefined()
  }),
)

it.effect("a user admission before commit rolls the whole checkpoint back, including the epoch and budget latch", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_watermark")
    const fixture = yield* armed(sessionID, { latch: true })
    const hooks = yield* PluginHooks.Service
    const inbox = yield* SessionInbox.Service
    const requestID = yield* request(fixture, sessionID)
    yield* hooks.register("session", "compaction", (event) =>
      Effect.gen(function* () {
        const checkpoint = (event as { readonly checkpoint?: CheckpointBinding }).checkpoint
        if (!checkpoint) return
        // A human prompt is admitted after the binding was prepared but before the native commit.
        yield* inbox.admit({ id: SessionMessage.ID.create(), sessionID, item: { type: "user", delivery: "steer", payload: { text: "STOP" } } }).pipe(Effect.orDie)
        event.result = { summary: checkpoint.rendered }
      }),
    )
    const epoch = () => fixture.db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).get().pipe(Effect.orDie)
    const latch = () => session(sessionID).pipe(Effect.map((info) => info.contextBudgetState))
    const before = { epoch: yield* epoch(), latch: yield* latch() }
    expect(before.latch).toEqual(LATCH)
    const { outcome } = yield* deliver(sessionID, fixture, requestID)
    expect(outcome).toMatchObject({ status: "failed", error: { type: "state-checkpoint.blocked" } })
    expect(yield* eventTypes(sessionID)).toEqual([ENQUEUED, DELIVERED, STARTED, ENQUEUED, FAILED])
    expect({ epoch: yield* epoch(), latch: yield* latch() }).toEqual(before)
    const status = yield* statusOf(fixture.db, sessionID)
    expect(status).toMatchObject({ ok: true, current: { revision: 1 }, outcome: { status: "blocked" } })
    expect(status.ok && status.current?.consumed).toBeUndefined()
    expect(status.ok && status.outcome?.message).toContain("user prompt")
    expect((yield* compactionRows(sessionID)).map((item) => (item.data as { status: string }).status)).toEqual(["failed"])
    expect(requests).toEqual([])
  }),
)

it.effect("a successful manual checkpoint resets the budget latch like any native checkpoint", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_latch")
    const fixture = yield* armed(sessionID, { latch: true })
    yield* echo([])
    const { outcome } = yield* deliver(sessionID, fixture, yield* request(fixture, sessionID))
    expect(outcome).toEqual({ status: "completed" })
    expect((yield* session(sessionID)).contextBudgetState).toBeUndefined()
    expect(requests).toEqual([])
  }),
)

it.effect("the receipt deadline is checked when requesting, while queued and during hooks", () =>
  Effect.gen(function* () {
    requests = []
    const hooks = yield* PluginHooks.Service
    const late = SessionStateCheckpoint.SNAPSHOT_TTL + 1_000

    const requested = Session.ID.make("ses_state_expired")
    const atRequest = yield* armed(requested)
    yield* TestClock.adjust(late)
    expect(
      yield* SessionStateCheckpoint.compact(atRequest.db, yield* inboxAdmit(), { sessionID: requested, source: atRequest.source, expectedRevision: 1 }),
    ).toMatchObject({ ok: false, error: "expired" })

    yield* echo([])
    const queued = Session.ID.make("ses_state_queued")
    const waiting = yield* armed(queued)
    const queuedID = yield* request(waiting, queued)
    yield* TestClock.adjust(late)
    expect((yield* deliver(queued, waiting, queuedID)).outcome).toMatchObject({ status: "failed" })
    const queuedStatus = yield* statusOf(waiting.db, queued)
    expect(queuedStatus.ok && queuedStatus.outcome?.message).toContain("expired")

    const hooked = Session.ID.make("ses_state_hooked")
    const during = yield* armed(hooked)
    const hookedID = yield* request(during, hooked)
    yield* hooks.register("session", "compaction", (event) =>
      (event as { readonly checkpoint?: CheckpointBinding }).checkpoint ? TestClock.adjust(late) : Effect.void,
    )
    expect((yield* deliver(hooked, during, hookedID)).outcome).toMatchObject({ status: "failed" })
    const hookedStatus = yield* statusOf(during.db, hooked)
    expect(hookedStatus.ok && hookedStatus.outcome?.message).toContain("expired")
    expect(hookedStatus.ok && hookedStatus.current?.consumed).toBeUndefined()
    expect(requests).toEqual([])
  }),
)

it.effect("opting in needs an active grant quoting a whole root human prompt; forks, children and peers are untouched", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const attempt = Effect.fnUntraced(function* (
      sessionID: Session.ID,
      prompt: string,
      options: { readonly quote?: string; readonly parent?: Session.ID; readonly fork?: boolean; readonly grant?: Record<string, unknown>; readonly review?: Record<string, unknown> } = {},
    ) {
      yield* insertSession(sessionID, {
        context_budget: policy,
        ...(options.parent ? { parent_id: options.parent } : {}),
        ...(options.fork ? { fork_session_id: Session.ID.make("ses_state_root") } : {}),
      })
      const grant = user(prompt)
      const answer = assistant([text("Noted.")])
      const tool = assistant([call("call_state", "controller_state", running)], false)
      yield* append(sessionID, [grant, answer, tool])
      const source = { messageID: tool.id, callID: "call_state" }
      const snap = yield* SessionStateCheckpoint.snapshot(db, { sessionID, source })
      if (!snap.ok) return yield* Effect.die(snap)
      const authority = [
        {
          source: { kind: "message" as const, sessionID, messageID: grant.id },
          exactText: options.quote ?? prompt,
          scope: SessionStateCheckpoint.OPT_IN_SCOPE,
          status: "active",
          negativeConstraints: [],
          ...options.grant,
        },
      ]
      const base = reviewed(sessionID, snap.coverage, { sessionID, messageID: answer.id }, { authority })
      const review = { ...base.review, ...options.review }
      const state = { ...base, review: { ...review, reviewedStateHash: SessionStateEnvelope.reviewTargetHash({ ...base, review }) } }
      return yield* SessionStateCheckpoint.update(db, { sessionID, source, expectedRevision: 0, snapshotID: snap.snapshotID, state, enabled: true })
    })
    const refused = { ok: false, error: "enable_unauthorised" }
    expect(yield* attempt(Session.ID.make("ses_state_unquoted"), "Marc: carry on.", { quote: GRANT })).toMatchObject(refused)
    expect(yield* attempt(Session.ID.make("ses_state_substring"), `Marc: ${GRANT}`, { quote: GRANT })).toMatchObject(refused)
    expect(yield* attempt(Session.ID.make("ses_state_peer"), `[cross-session message from ses_x] ${GRANT}`)).toMatchObject(refused)
    expect(yield* attempt(Session.ID.make("ses_state_revoked"), GRANT, { grant: { status: "revoked" } })).toMatchObject(refused)
    expect(yield* attempt(Session.ID.make("ses_state_expired_grant"), GRANT, { grant: { status: "expired" } })).toMatchObject(refused)
    const superseded = Session.ID.make("ses_state_superseded")
    expect(
      yield* attempt(superseded, GRANT, { grant: { supersededBy: { kind: "file", path: "/evidence/later.md", sha256: "a".repeat(64) } } }),
    ).toMatchObject(refused)
    const root = Session.ID.make("ses_state_root")
    expect(yield* armed(root)).toMatchObject({ updated: { ok: true } })
    // A delegated child's initial prompt and a prompt copied into a fork are not a human grant for that session.
    expect(yield* attempt(Session.ID.make("ses_state_child"), GRANT, { parent: root })).toMatchObject({
      ...refused,
      message: "Only a root session that is not a fork can opt in",
    })
    expect(yield* attempt(Session.ID.make("ses_state_fork"), GRANT, { fork: true })).toMatchObject(refused)
    // Review envelope facts are required, not decorative.
    expect(yield* attempt(Session.ID.make("ses_state_unattested"), GRANT, { review: { completenessAttestation: " " } })).toMatchObject({
      ok: false,
      error: "invalid_state",
    })
    expect(yield* attempt(Session.ID.make("ses_state_future"), GRANT, { review: { reviewedAt: "1970-01-01T00:00:01.000Z" } })).toMatchObject({
      ok: false,
      error: "invalid_state",
    })
    expect(yield* attempt(Session.ID.make("ses_state_unreviewed"), GRANT, { review: { reviewerEvidence: [] } })).toMatchObject({
      ok: false,
      error: "invalid_state",
    })
    expect(yield* SessionStateCheckpoint.engaged(db, Session.ID.make("ses_state_child"))).toBe(false)
    expect(yield* SessionStateCheckpoint.engaged(db, Session.ID.make("ses_state_fork"))).toBe(false)

    // Stored but not enabled: compaction stays the ordinary model summary.
    const plain = Session.ID.make("ses_state_disabled")
    expect(yield* armed(plain, { enable: false })).toMatchObject({ updated: { ok: true, receipt: { enabled: false } } })
    expect(yield* SessionStateCheckpoint.engaged(db, plain)).toBe(false)
    const outcome = yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(plain), [user("hello")]) })
    expect(outcome).toEqual({ status: "completed" })
    expect(requests).toHaveLength(1)
  }),
)

it.effect("updates are full-state CAS on a fresh, unused, unexpired snapshot from a live call", () =>
  Effect.gen(function* () {
    const sessionID = Session.ID.make("ses_state_cas")
    const fixture = yield* armed(sessionID, { enable: false })
    const { db, source } = fixture
    const fresh = yield* SessionStateCheckpoint.snapshot(db, { sessionID, source })
    if (!fresh.ok) return yield* Effect.die(fresh)
    const next = (overrides: Partial<State> = {}) =>
      reviewed(sessionID, fresh.coverage, { sessionID, messageID: fixture.answer.id }, overrides)
    const update = (input: { expectedRevision?: number; snapshotID?: string; state?: unknown; source?: typeof source }) =>
      SessionStateCheckpoint.update(db, {
        sessionID,
        source: input.source ?? source,
        expectedRevision: input.expectedRevision ?? 1,
        snapshotID: input.snapshotID ?? fresh.snapshotID,
        state: input.state ?? next(),
        enabled: false,
      })
    const invalid = { ok: false, error: "invalid_state" }
    expect(yield* update({ expectedRevision: 0 })).toMatchObject({ ok: false, error: "stale_revision" })
    expect(yield* update({ snapshotID: fixture.snap.ok ? fixture.snap.snapshotID : "" })).toMatchObject({ ok: false, error: "snapshot_invalid" })
    expect(yield* update({ source: { messageID: fixture.tool.id, callID: "call_copied" } })).toMatchObject({ ok: false, error: "invalid_source" })
    expect(yield* update({ state: { ...next(), extra: true } })).toMatchObject(invalid)
    expect(yield* update({ state: { ...next(), review: { ...next().review, reviewedStateHash: "0".repeat(64) } } })).toMatchObject(invalid)
    expect(yield* update({ state: next({ evidence: [{ kind: "message", sessionID: "ses_unrelated", messageID: "msg_x" }] }) })).toMatchObject({
      ...invalid,
      message: expect.stringContaining("lineage"),
    })
    // A call reference must name a settled tool call of exactly that covered assistant message.
    const ref = (messageID: string, callID: string) => next({ evidence: [{ kind: "message", sessionID, messageID, callID }] })
    expect(yield* update({ state: ref(fixture.answer.id, "call_read") })).toMatchObject({ ...invalid, message: expect.stringContaining("settled tool call") })
    expect(yield* update({ state: ref(fixture.read.id, "call_other") })).toMatchObject({ ...invalid, message: expect.stringContaining("settled tool call") })
    expect(yield* update({ state: ref(fixture.tool.id, "call_state") })).toMatchObject({ ...invalid, message: expect.stringContaining("covered history") })
    const budget = (consumed: string, remaining: string) => ({
      id: "b",
      source: { kind: "message" as const, sessionID, messageID: fixture.grant.id },
      unit: "GBP",
      allocation: "10.5",
      consumed,
      remaining,
      expires: "unknown",
      oneOff: true,
      outcome: "open",
    })
    expect(yield* update({ state: next({ budgets: [budget("3", "7")] }) })).toMatchObject(invalid)
    expect(yield* update({ state: next({ budgets: [budget("unknown", "7")] }) })).toMatchObject(invalid)
    // The 32 KiB limit is on the complete rendered envelope in UTF-8 bytes, not characters or the bare state.
    const open = (id: string, question: string) => ({ id, questionOrOutcome: question, state: "open", safeDefault: "hold", evidence: [] })
    expect(yield* update({ state: next({ unresolved: [open("u", "é".repeat(SessionStateEnvelope.BYTES / 2))] }) })).toMatchObject({
      ok: false,
      error: "state_too_large",
    })
    expect(yield* update({ state: next({ unresolved: Array.from({ length: 600 }, (_, index) => open(`u${index}`, "q")) }) })).toMatchObject({
      ok: false,
      error: "state_too_large",
    })
    expect(yield* update({ state: ref(fixture.read.id, "call_read") })).toMatchObject({ ok: true, receipt: { revision: 2 } })
    // Used snapshots and the superseded revision cannot be replayed.
    expect(yield* update({ expectedRevision: 2 })).toMatchObject({ ok: false, error: "snapshot_invalid" })
    expect(yield* update({})).toMatchObject({ ok: false, error: "stale_revision" })
    // An expired snapshot cannot be used.
    const stale = yield* SessionStateCheckpoint.snapshot(db, { sessionID, source })
    if (!stale.ok) return yield* Effect.die(stale)
    yield* TestClock.adjust(SessionStateCheckpoint.SNAPSHOT_TTL + 1_000)
    expect(yield* update({ expectedRevision: 2, snapshotID: stale.snapshotID })).toMatchObject({ ok: false, error: "snapshot_invalid" })
    // A later user admission invalidates an outstanding snapshot.
    const later = yield* SessionStateCheckpoint.snapshot(db, { sessionID, source })
    if (!later.ok) return yield* Effect.die(later)
    const inbox = yield* SessionInbox.Service
    yield* inbox.admit({ id: SessionMessage.ID.create(), sessionID, item: { type: "user", delivery: "queue", payload: { text: "new" } } })
    expect(
      yield* update({ expectedRevision: 2, snapshotID: later.snapshotID, state: reviewed(sessionID, later.coverage, { sessionID, messageID: fixture.answer.id }) }),
    ).toMatchObject({ ok: false, error: "coverage_changed" })
  }),
)

it.effect("the review hash excludes the review envelope; the receipt hash covers the complete state", () =>
  Effect.gen(function* () {
    const sessionID = Session.ID.make("ses_state_hashes")
    const coverage = { checkpointSeq: 0, fromSeq: 0, coveredSeq: 1, coveredMessageID: "msg_x", prefixHash: "p", userAdmission: 0, instructionHash: "i", directory: "/project" }
    const state = reviewed(sessionID, coverage, { sessionID, messageID: "msg_y" })
    const full = SessionStateEnvelope.stateHash(state)
    expect(full).not.toBe(state.review.reviewedStateHash)
    const changes = [
      { reviewerEvidence: [{ kind: "message" as const, sessionID, messageID: "msg_z" }] },
      { reviewedAt: "1970-01-01T00:00:01.000Z" },
      { completenessAttestation: "Another attestation" },
      { currentThrough: { ...coverage, coveredSeq: 2 } },
    ]
    for (const change of changes) {
      const changed = { ...state, review: { ...state.review, ...change } }
      expect(SessionStateEnvelope.stateHash(changed)).not.toBe(full)
      expect(SessionStateEnvelope.reviewTargetHash(changed)).toBe(state.review.reviewedStateHash)
    }
    const reordered = Object.fromEntries(Object.entries(state).reverse()) as State
    expect(SessionStateEnvelope.stateHash(reordered)).toBe(full)
  }),
)

it.effect("a bound request never adopts a different pending compaction, and a plain control cannot fall back", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_pending")
    const fixture = yield* armed(sessionID)
    const inbox = yield* SessionInbox.Service
    const admit = yield* inboxAdmit()
    const plain = SessionMessage.ID.create()
    yield* inbox.admitCompaction({ id: plain, sessionID, delivery: "steer" })
    const conflict = yield* SessionStateCheckpoint.compact(fixture.db, admit, { sessionID, source: fixture.source, expectedRevision: 1 })
    expect(conflict).toMatchObject({ ok: false, error: "compaction_pending" })
    expect((yield* SessionInbox.list(fixture.db, sessionID)).map((item) => item.payload)).toEqual([{}])
    const seen: CheckpointBinding[] = []
    yield* echo(seen)
    // The plain control reaches an opted-in session: no binding, so blocked rather than summarised.
    expect(yield* manual(yield* session(sessionID), [], plain)).toMatchObject({ status: "failed", error: { type: "state-checkpoint.blocked" } })
    expect(requests).toEqual([])
    expect(seen).toEqual([])

    const other = Session.ID.make("ses_state_retry")
    const retry = yield* armed(other)
    const requestID = SessionMessage.ID.create()
    const first = yield* SessionStateCheckpoint.compact(retry.db, admit, { sessionID: other, source: retry.source, expectedRevision: 1, requestID })
    expect(first).toMatchObject({ ok: true, requestID, revision: 1 })
    expect(yield* SessionStateCheckpoint.compact(retry.db, admit, { sessionID: other, source: retry.source, expectedRevision: 1, requestID })).toEqual(first)
    const snap = yield* SessionStateCheckpoint.snapshot(retry.db, { sessionID: other, source: retry.source })
    if (!snap.ok) return yield* Effect.die(snap)
    const state = reviewed(other, snap.coverage, { sessionID: other, messageID: retry.answer.id }, { authority: retry.state.authority })
    expect(
      yield* SessionStateCheckpoint.update(retry.db, { sessionID: other, source: retry.source, expectedRevision: 1, snapshotID: snap.snapshotID, state, enabled: true }),
    ).toMatchObject({ ok: true, receipt: { revision: 2 } })
    // The same control ID stays bound to revision 1, so it cannot be re-used for revision 2.
    expect(
      yield* SessionStateCheckpoint.compact(retry.db, admit, { sessionID: other, source: retry.source, expectedRevision: 2, requestID }),
    ).toMatchObject({ ok: false, error: "compaction_pending" })
    // Delivering that stale control blocks instead of checkpointing revision 2 under revision 1's binding.
    yield* replace(other, assistant([call("call_state", "controller_state", done("ok"))], true, retry.tool.id))
    expect(yield* manual(yield* session(other), [], requestID)).toMatchObject({ status: "failed" })
    expect(requests).toEqual([])
  }),
)

it.effect("the next snapshot covers retained rows before the latest marker, and each generation keeps its tail", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_generations")
    const fixture = yield* armed(sessionID)
    yield* echo([])
    const first = fixture.snap.ok ? fixture.snap.coverage : undefined
    const { settled, later } = yield* deliver(sessionID, fixture, yield* request(fixture, sessionID))
    const after = user(`Arrived after the marker ${LONG}`)
    const next = assistant([call("call_next", "controller_state", running)], false)
    yield* append(sessionID, [after, next])
    const source = { messageID: next.id, callID: "call_next" }
    const [marker] = yield* compactionRows(sessionID)

    const snap = yield* SessionStateCheckpoint.snapshot(fixture.db, { sessionID, source })
    if (!snap.ok) return yield* Effect.die(snap)
    // The retained rows between the first coverage and its marker belong to the next coverage.
    expect(snap.coverage).toMatchObject({ checkpointSeq: marker!.seq, fromSeq: first!.coveredSeq + 1 })
    expect(snap.coverage.fromSeq).toBeLessThan(marker!.seq)
    const state = () =>
      Effect.gen(function* () {
        const fresh = yield* SessionStateCheckpoint.snapshot(fixture.db, { sessionID, source })
        if (!fresh.ok) return yield* Effect.die(fresh)
        return {
          fresh,
          state: reviewed(sessionID, fresh.coverage, { sessionID, messageID: fixture.answer.id }, { authority: fixture.state.authority }),
        }
      })
    // C1: editing a retained tool row after the snapshot stales it.
    const stale = reviewed(sessionID, snap.coverage, { sessionID, messageID: fixture.answer.id }, { authority: fixture.state.authority })
    const edited = assistant([call("call_state", "controller_state", done("edited"))], true, settled.id)
    yield* replace(sessionID, edited)
    expect(
      yield* SessionStateCheckpoint.update(fixture.db, { sessionID, source, expectedRevision: 1, snapshotID: snap.snapshotID, state: stale, enabled: true }),
    ).toMatchObject({ ok: false, error: "coverage_changed" })

    // C2: the second generation covers them and keeps only its own tail.
    const second = yield* state()
    expect(
      yield* SessionStateCheckpoint.update(fixture.db, { sessionID, source, expectedRevision: 1, snapshotID: second.fresh.snapshotID, state: second.state, enabled: true }),
    ).toMatchObject({ ok: true, receipt: { revision: 2 } })
    const requestID = yield* SessionStateCheckpoint.compact(fixture.db, yield* inboxAdmit(), { sessionID, source, expectedRevision: 2 })
    if (!requestID.ok) return yield* Effect.die(requestID)
    const nextSettled = assistant([call("call_next", "controller_state", done(`Second ${LONG}`))], true, next.id)
    yield* replace(sessionID, nextSettled)
    expect(yield* manual(yield* session(sessionID), [], requestID.requestID as SessionMessage.ID)).toEqual({ status: "completed" })
    const history = yield* SessionHistory.load(fixture.db, sessionID, "local")
    expect(history[0]).toMatchObject({ type: "compaction", status: "completed", summary: SessionStateEnvelope.render(second.state, 2, SessionStateEnvelope.stateHash(second.state)) })
    expect(history.slice(1)).toEqual([nextSettled])
    expect(JSON.stringify(history)).not.toContain(later.text)
    expect(requests).toEqual([])
  }),
)

/**
 * Event-only replay: a replica that has the durable events but none of the private KV records. The durable envelope
 * keeps the typed tail; the missing receipt blocks as recovery required instead of falling back to a model summary.
 */
it.effect("event-only replay of a completed checkpoint keeps the typed tail and blocks without a model summary", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_replay")
    const fixture = yield* armed(sessionID)
    const bus = yield* Bus.Service
    yield* echo([])
    const { settled, later, outcome } = yield* deliver(sessionID, fixture, yield* request(fixture, sessionID))
    expect(outcome).toEqual({ status: "completed" })
    const before = yield* SessionHistory.load(fixture.db, sessionID, "local")
    expect(before.slice(1)).toEqual([settled, later])

    const events = yield* fixture.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    const checkpoint = events.filter((event) => event.type === STARTED || event.type === ENDED)
    expect(checkpoint.map((event) => event.type)).toEqual([STARTED, ENDED])
    // Replay after the bound control was delivered: its inbox row is gone, as on a replica.
    // Drop the projections and private KV, then replay just those durable events.
    const first = checkpoint[0]!.seq
    yield* fixture.db.delete(EventTable).where(and(eq(EventTable.aggregate_id, sessionID), gte(EventTable.seq, first))).run().pipe(Effect.orDie)
    yield* fixture.db.update(EventSequenceTable).set({ seq: first - 1 }).where(eq(EventSequenceTable.aggregate_id, sessionID)).run().pipe(Effect.orDie)
    yield* fixture.db
      .delete(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
      .run()
      .pipe(Effect.orDie)
    yield* fixture.db.delete(KVTable).where(like(KVTable.key, `session/state-checkpoint/${sessionID}/%`)).run().pipe(Effect.orDie)
    for (const event of checkpoint)
      yield* bus.replay({ id: event.id, type: event.type, seq: event.seq, aggregateID: sessionID, created: event.created, data: event.data })

    const replayed = yield* SessionHistory.load(fixture.db, sessionID, "local")
    expect(replayed.slice(1)).toEqual([settled, later])
    const compaction = yield* SessionCompaction.Service
    const again = yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(sessionID), [later]) })
    expect(again).toMatchObject({ status: "failed", error: { type: "state-checkpoint.blocked", message: expect.stringContaining("Recovery required") } })
    expect(requests).toHaveLength(0)

    // A recognised envelope that no longer decodes fails history as recovery required.
    const [marker] = (yield* compactionRows(sessionID)).filter((item) => (item.data as { status: string }).status === "completed")
    const data = marker!.data as { summary: string }
    yield* fixture.db
      .update(SessionMessageTable)
      .set({ data: { ...data, summary: data.summary.replace('"version":1', '"version":2') } as never })
      .where(eq(SessionMessageTable.id, marker!.id))
      .run()
      .pipe(Effect.orDie)
    expect(yield* SessionHistory.load(fixture.db, sessionID, "local").pipe(Effect.flip)).toMatchObject({ _tag: "Session.MessageDecodeError" })
  }),
)

it.effect("a pending bound control without its local receipt blocks as recovery required", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_orphan")
    const fixture = yield* armed(sessionID)
    yield* echo([])
    const requestID = yield* request(fixture, sessionID)
    yield* fixture.db.delete(KVTable).where(like(KVTable.key, `session/state-checkpoint/${sessionID}/%`)).run().pipe(Effect.orDie)
    expect(yield* SessionStateCheckpoint.engaged(fixture.db, sessionID)).toBe(true)
    const compaction = yield* SessionCompaction.Service
    expect(yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(sessionID), []) })).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("Recovery required") },
    })
    expect((yield* deliver(sessionID, fixture, requestID)).outcome).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("Recovery required") },
    })
    expect(requests).toEqual([])
  }),
)

/** A native user shell record, as `Session.shell` stores one; this harness has no shell runtime. */
const shell = (command: string, overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(SessionMessage.Info)({
    id: SessionMessage.ID.create(),
    type: "shell",
    shellID: `sh_${crypto.randomUUID().replaceAll("-", "")}`,
    command,
    status: "exited",
    time: { created: 0, completed: 0 },
    ...(overrides.status === "running" ? {} : { exit: 0 }),
    ...overrides,
  })
const BLOCKED = { blocked: { reason: "Protected floor", maximum: 180_000, selection: "null" } }
const block = (db: Database.Interface["db"], sessionID: Session.ID, state: unknown = BLOCKED) =>
  db.update(SessionTable).set({ context_budget_state: state as never }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)

it.effect("maintenance revalidates exact native intent in snapshot, update and compact transactions", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const store = yield* SessionStore.Service
    for (const operation of ["snapshot", "update", "compact"] as const) {
      for (const damage of ["command", "shellID", "status", "exit", "missing"] as const) {
        const sessionID = Session.ID.make(`ses_intent_${operation}_${damage}`)
        const f = yield* armed(sessionID)
        yield* replace(sessionID, assistant([call("call_state", "controller_state", done("ok"))], true, f.tool.id))
        yield* block(f.db, sessionID)
        const admit = yield* inboxAdmit()
        const host = { get: (id: Session.ID) => store.get(id).pipe(Effect.flatMap((found) => found ? Effect.succeed(found) : Effect.die(id))), compact: admit }
        yield* append(sessionID, [shell(SessionStateCheckpoint.intent("snapshot", 1))])
        const snap = yield* SessionStateCheckpoint.maintainFor(f.db, host, { sessionID, operation: "snapshot", expectedRevision: 1 })
        if (!snap.ok || !("coverage" in snap) || !snap.coverage || !snap.snapshotID) return yield* Effect.die(snap)
        const state = reviewed(sessionID, snap.coverage, { sessionID, messageID: f.answer.id }, { authority: f.state.authority })
        const hash = SessionStateEnvelope.stateHash(operation === "compact" ? f.state : state)
        const original = shell(SessionStateCheckpoint.intent(operation, 1, operation === "snapshot" ? undefined : hash))
        yield* append(sessionID, [original])
        const input = { sessionID, operation, expectedRevision: 1, snapshotID: snap.snapshotID, state }
        const before = yield* f.db.select().from(KVTable).where(like(KVTable.key, `session/state-checkpoint/${sessionID}/%`)).all().pipe(Effect.orDie)
        const mutate = damage === "missing"
          ? f.db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, original.id)).run().pipe(Effect.orDie)
          : replace(sessionID, { ...original, ...({ command: { command: "# unrelated" }, shellID: { shellID: "sh_changed" }, status: { status: "running" }, exit: { exit: 1 } }[damage]) } as SessionMessage.Info).pipe(Effect.provideService(Database.Service, database))
        const delayed = new Proxy(f.db, {
          get(target, property) {
            // oxlint-disable-next-line no-restricted-globals -- Genuine proxy reflection: every non-transaction member keeps its original behaviour.
            if (property !== "transaction") return Reflect.get(target, property)
            return (...args: Parameters<typeof target.transaction>) => Effect.gen(function* () {
              yield* mutate
              return yield* target.transaction(...args)
            })
          },
        })
        // Compaction owns its admission transaction; inject immediately before that real boundary.
        const compact: typeof admit = (request) => Effect.gen(function* () {
          yield* mutate
          return yield* admit(request)
        })
        expect(yield* SessionStateCheckpoint.maintainFor(delayed, { ...host, compact }, input)).toMatchObject({ ok: false, error: "intent_required" })
        expect(yield* f.db.select().from(KVTable).where(like(KVTable.key, `session/state-checkpoint/${sessionID}/%`)).all().pipe(Effect.orDie)).toEqual(before)
        expect(yield* SessionInbox.list(f.db, sessionID)).toEqual([])
        // Restoring the identical source permits retry: rejection consumed neither intent nor state.
        if (damage === "missing") yield* append(sessionID, [original])
        else yield* replace(sessionID, original)
        expect(yield* SessionStateCheckpoint.maintainFor(f.db, host, input)).toMatchObject({ ok: true })
      }
    }
  }),
)

it.effect("operator maintenance needs a blocked opted-in root session and one fresh exact native shell intent per operation", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_maintain")
    const fixture = yield* armed(sessionID)
    const { db } = fixture
    yield* replace(sessionID, assistant([call("call_state", "controller_state", done("ok"))], true, fixture.tool.id))
    const admit = yield* inboxAdmit()
    const maintain = (input: Omit<Parameters<typeof SessionStateCheckpoint.maintain>[3], "sessionID">) =>
      Effect.gen(function* () {
        return yield* SessionStateCheckpoint.maintain(db, yield* session(sessionID), admit, { ...input, sessionID })
      })
    const snapshot = { operation: "snapshot" as const, expectedRevision: 1 }
    const intent = SessionStateCheckpoint.intent("snapshot", 1)
    expect(intent).toBe("# controller-state snapshot revision=1")

    // A prompt quoting the intent is not a native shell intent.
    yield* block(db, sessionID)
    yield* append(sessionID, [user(intent)])
    expect(yield* maintain(snapshot)).toMatchObject({ ok: false, error: "intent_required", intent })
    // Not blocked: no maintenance, even with the exact intent.
    yield* block(db, sessionID, null)
    yield* append(sessionID, [shell(intent)])
    expect(yield* maintain(snapshot)).toMatchObject({ ok: false, error: "maintenance_unavailable" })
    // Blocked for another model selection: still unavailable.
    yield* block(db, sessionID, { blocked: { ...BLOCKED.blocked, selection: '{"id":"other"}' } })
    expect(yield* maintain(snapshot)).toMatchObject({ ok: false, error: "maintenance_unavailable" })
    yield* block(db, sessionID)
    expect(yield* maintain({ ...snapshot, expectedRevision: 0 })).toMatchObject({ ok: false, error: "stale_revision" })

    // The latest shell record must be this exact, successful command.
    for (const record of [shell(`${intent} `), shell(intent, { exit: 1 }), shell(intent, { status: "running", time: { created: 0 } })]) {
      yield* append(sessionID, [record])
      expect(yield* maintain(snapshot)).toMatchObject({ ok: false, error: "intent_required", intent })
    }
    yield* append(sessionID, [shell(intent)])
    const snap = yield* maintain(snapshot)
    expect(snap).toMatchObject({ ok: true, revision: 1 })
    if (!snap.ok || !("snapshotID" in snap) || !snap.coverage) return yield* Effect.die(snap)
    // Each intent is single use.
    expect(yield* maintain(snapshot)).toMatchObject({ ok: false, error: "intent_required" })

    // Update binds the full hash of the reviewed state it names.
    const state = reviewed(sessionID, snap.coverage, { sessionID, messageID: fixture.answer.id }, { authority: fixture.state.authority })
    const hash = SessionStateEnvelope.stateHash(state)
    const update = { operation: "update" as const, expectedRevision: 1, snapshotID: snap.snapshotID, state }
    yield* append(sessionID, [shell(SessionStateCheckpoint.intent("update", 1, "0".repeat(64)))])
    expect(yield* maintain(update)).toMatchObject({ ok: false, error: "intent_required", intent: SessionStateCheckpoint.intent("update", 1, hash) })
    yield* append(sessionID, [shell(SessionStateCheckpoint.intent("update", 1, hash))])
    expect(yield* maintain(update)).toMatchObject({ ok: true, receipt: { revision: 2, stateHash: hash, enabled: true } })

    // Compact admits a maintenance-origin bound control for the current hash, nothing more.
    yield* append(sessionID, [shell(SessionStateCheckpoint.intent("compact", 2, hash))])
    const compacted = yield* maintain({ operation: "compact", expectedRevision: 2 })
    expect(compacted).toMatchObject({ ok: true, revision: 2, stateHash: hash })
    const control = (yield* SessionInbox.list(db, sessionID)).find((item) => item.type === "compaction")
    expect(control?.payload).toEqual({ checkpoint: { version: 1, sessionID, revision: 2, stateHash: hash, maintenance: true } })
    expect(yield* SessionInbox.list(db, sessionID)).toHaveLength(1)
    expect(requests).toEqual([])
  }),
)

it.effect("operator maintenance is unavailable to disabled, child and fork sessions", () =>
  Effect.gen(function* () {
    const disabled = Session.ID.make("ses_state_maintain_off")
    const off = yield* armed(disabled, { enable: false })
    yield* block(off.db, disabled)
    yield* append(disabled, [shell(SessionStateCheckpoint.intent("snapshot", 1))])
    const admit = yield* inboxAdmit()
    expect(yield* SessionStateCheckpoint.maintain(off.db, yield* session(disabled), admit, { sessionID: disabled, operation: "snapshot", expectedRevision: 1 })).toMatchObject({
      ok: false,
      error: "not_enabled",
    })
    // A child or fork never reaches an enabled receipt, and even a forged parent link refuses maintenance.
    const root = Session.ID.make("ses_state_maintain_root")
    const fixture = yield* armed(root)
    yield* block(fixture.db, root)
    yield* append(root, [shell(SessionStateCheckpoint.intent("snapshot", 1))])
    const info = yield* session(root)
    for (const forged of [{ ...info, parentID: Session.ID.make("ses_state_parent") }, { ...info, fork: { sessionID: disabled } }])
      expect(yield* SessionStateCheckpoint.maintain(fixture.db, forged as never, admit, { sessionID: root, operation: "snapshot", expectedRevision: 1 })).toMatchObject({
        ok: false,
        error: "maintenance_unavailable",
      })
  }),
)

/** Completes C1, then reviews and enables C2 whose citations all lie before C2's fingerprint window. */
const secondGeneration = Effect.fnUntraced(function* (sessionID: Session.ID, options: { readonly latch?: boolean } = {}) {
  const fixture = yield* armed(sessionID, options)
  yield* echo([])
  yield* deliver(sessionID, fixture, yield* request(fixture, sessionID))
  const next = assistant([call("call_next", "controller_state", running)], false)
  yield* append(sessionID, [user("A new settled boundary"), next])
  const source = { messageID: next.id, callID: "call_next" }
  const snap = yield* SessionStateCheckpoint.snapshot(fixture.db, { sessionID, source })
  if (!snap.ok) return yield* Effect.die(snap)
  // Every citation below lies before the C2 window.
  expect(snap.coverage.fromSeq).toBeGreaterThan(fixture.snap.ok ? fixture.snap.coverage.coveredSeq : Infinity)
  const state = reviewed(sessionID, snap.coverage, { sessionID, messageID: fixture.answer.id }, {
    authority: fixture.state.authority,
    evidence: [{ kind: "message", sessionID, messageID: fixture.read.id, callID: "call_read" }],
  })
  expect(
    yield* SessionStateCheckpoint.update(fixture.db, { sessionID, source, expectedRevision: 1, snapshotID: snap.snapshotID, state, enabled: true }),
  ).toMatchObject({ ok: true, receipt: { revision: 2 } })
  const settle = replace(sessionID, assistant([call("call_next", "controller_state", done("ok"))], true, next.id))
  return { fixture, source, state, settle }
})

it.effect("checkpoint admission reads split assistant parts and rejects changed part evidence", () =>
  Effect.gen(function* () {
    const sessionID = Session.ID.make("ses_state_split_parts")
    const fixture = yield* armed(sessionID)
    for (const message of [fixture.answer, fixture.read, fixture.tool]) {
      yield* fixture.db.insert(SessionPartTable).values(message.content.map((part, ordinal) => ({
        message_id: message.id,
        session_id: sessionID,
        ordinal,
        type: part.type,
        data: Schema.encodeSync(SessionMessage.AssistantContent)(part),
      }))).run().pipe(Effect.orDie)
      yield* replace(sessionID, { ...message, content: [] })
    }
    const snapshot = yield* SessionStateCheckpoint.snapshot(fixture.db, { sessionID, source: fixture.source })
    expect(snapshot).toMatchObject({ ok: true })
    const admitted = yield* SessionStateCheckpoint.compact(fixture.db, yield* inboxAdmit(), {
      sessionID, source: fixture.source, expectedRevision: 1,
    })
    expect(admitted).toMatchObject({ ok: true })
    yield* fixture.db.update(SessionPartTable).set({ data: Schema.encodeSync(SessionMessage.AssistantContent)({ type: "text", text: "Changed reviewer evidence" }) })
      .where(eq(SessionPartTable.message_id, fixture.answer.id)).run().pipe(Effect.orDie)
    expect(yield* SessionStateCheckpoint.compact(fixture.db, yield* inboxAdmit(), {
      sessionID, source: fixture.source, expectedRevision: 1,
    })).toMatchObject({ ok: false, error: "coverage_changed" })
  }),
)

it.effect("a later generation revalidates the exact native sources it cites, even before its coverage window", () =>
  Effect.gen(function* () {
    requests = []
    // Each cited source: the authority grant, the reviewer's evidence and a settled tool call.
    const mutations = [
      (f: Effect.Success<ReturnType<typeof armed>>) => ({ ...f.grant, text: "Do NOT use controller-state checkpoints for this session." }),
      (f: Effect.Success<ReturnType<typeof armed>>) => assistant([text("Changed reviewer evidence.")], true, f.answer.id),
      (f: Effect.Success<ReturnType<typeof armed>>) => assistant([call("call_read", "read", done("changed")), text("Done.")], true, f.read.id),
      (f: Effect.Success<ReturnType<typeof armed>>) => assistant([call("call_other", "read", done("read")), text("Done.")], true, f.read.id),
    ]
    for (const [index, mutate] of mutations.entries()) {
      const sessionID = Session.ID.make(`ses_state_cited_${index}`)
      const { fixture, source } = yield* secondGeneration(sessionID)
      yield* replace(sessionID, mutate(fixture))
      expect(yield* SessionStateCheckpoint.compact(fixture.db, yield* inboxAdmit(), { sessionID, source, expectedRevision: 2 })).toMatchObject({
        ok: false,
        error: "coverage_changed",
        message: "A native source the reviewed state cites changed",
      })
    }
    // Admitted first, then changed: prepare blocks before any hook.
    const queued = Session.ID.make("ses_state_cited_queued")
    const later = yield* secondGeneration(queued)
    const requestID = yield* SessionStateCheckpoint.compact(later.fixture.db, yield* inboxAdmit(), { sessionID: queued, source: later.source, expectedRevision: 2 })
    if (!requestID.ok) return yield* Effect.die(requestID)
    yield* later.settle
    yield* replace(queued, { ...later.fixture.grant, text: "Changed after admission." })
    expect(yield* manual(yield* session(queued), [], requestID.requestID as SessionMessage.ID)).toMatchObject({
      status: "failed",
      error: { message: "A native source the reviewed state cites changed" },
    })
    expect(requests).toEqual([])
  }),
)

it.effect("a cited source changed during hooks rolls the checkpoint back without consuming or resetting the latch", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_cited_hook")
    const { fixture, source, settle } = yield* secondGeneration(sessionID, { latch: true })
    const requestID = yield* SessionStateCheckpoint.compact(fixture.db, yield* inboxAdmit(), { sessionID, source, expectedRevision: 2 })
    if (!requestID.ok) return yield* Effect.die(requestID)
    yield* settle
    yield* block(fixture.db, sessionID, LATCH)
    const hooks = yield* PluginHooks.Service
    const database = yield* Database.Service
    yield* hooks.register("session", "compaction", (event) =>
      (event as { readonly checkpoint?: CheckpointBinding }).checkpoint
        ? replace(sessionID, { ...fixture.grant, text: "Withdrawn during the hook." }).pipe(Effect.provideService(Database.Service, database))
        : Effect.void,
    )
    const outcome = yield* manual(yield* session(sessionID), [], requestID.requestID as SessionMessage.ID)
    expect(outcome).toMatchObject({ status: "failed", error: { type: "state-checkpoint.blocked" } })
    const status = yield* statusOf(fixture.db, sessionID)
    expect(status).toMatchObject({ ok: true, current: { revision: 2 }, outcome: { status: "blocked" } })
    expect(status.ok && status.current?.consumed).toBeUndefined()
    expect((yield* session(sessionID)).contextBudgetState).toEqual(LATCH)
    expect(requests).toEqual([])
  }),
)

it.effect("present invalid native checkpoint provenance blocks history, compaction and idle execution", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_state_invalid_provenance")
    const f = yield* armed(sessionID)
    yield* echo([])
    yield* deliver(sessionID, f, yield* request(f, sessionID))
    const [marker] = yield* compactionRows(sessionID)
    const data = marker!.data as Record<string, unknown>
    yield* f.db.delete(KVTable).where(like(KVTable.key, `session/state-checkpoint/${sessionID}/%`)).run().pipe(Effect.orDie)
    const compaction = yield* SessionCompaction.Service
    for (const checkpoint of [{ ...(data.checkpoint as object), sessionID: "ses_foreign" }, { version: 2 }, null, false, 0, "invalid", JSON.stringify(data.checkpoint)]) {
      yield* f.db.update(SessionMessageTable).set({ data: { ...data, checkpoint } as never }).where(eq(SessionMessageTable.id, marker!.id)).run().pipe(Effect.orDie)
      expect(yield* SessionStateCheckpoint.engaged(f.db, sessionID)).toBe(true)
      expect(yield* SessionStateCheckpoint.held(f.db, sessionID)).toBe(true)
      yield* SessionStateCheckpoint.release(f.db, sessionID)
      expect(yield* SessionStateCheckpoint.held(f.db, sessionID)).toBe(true)
      expect((yield* SessionHistory.load(f.db, sessionID, "local").pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* compaction.compact({ reason: "manual", inputID: SessionMessage.ID.create(), context: loaded(yield* session(sessionID), []) })).toMatchObject({ status: "failed" })
      expect(requests).toEqual([])
    }
  }),
)

it.effect("ordinary summaries that mention or copy the format stay ordinary; bound or replayed checkpoints fail closed", () =>
  Effect.gen(function* () {
    requests = []
    const hooks = yield* PluginHooks.Service
    const compaction = yield* SessionCompaction.Service
    let summary = ""
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        if (!(event as { readonly checkpoint?: CheckpointBinding }).checkpoint) event.result = { summary }
      }),
    )
    yield* echo([])
    // A genuine checkpoint of another session, to copy.
    const other = Session.ID.make("ses_state_copied_from")
    const source = yield* armed(other)
    yield* deliver(other, source, yield* request(source, other))
    const [copied] = yield* compactionRows(other)
    const copiedText = (copied!.data as { summary: string }).summary
    const ordinary: ReadonlyArray<(fixture: Effect.Success<ReturnType<typeof armed>>) => string> = [
      () => "<controller-state is an example, not an actual checkpoint>\nKeep normal session behaviour.",
      () => `<controller-state version="1" revision="1">\nA quoted header without a hash.`,
      () => copiedText,
      () => copiedText.replace('version="1"', 'version="2"'),
      // A complete, valid envelope naming this very session and its real rows: still only text without a binding.
      (fixture) => SessionStateEnvelope.render(fixture.state, 1, SessionStateEnvelope.stateHash(fixture.state)),
    ]
    for (const [index, make] of ordinary.entries()) {
      const sessionID = Session.ID.make(`ses_state_ordinary_${index}`)
      const fixture = yield* armed(sessionID, { enable: false })
      yield* fixture.db.delete(KVTable).where(like(KVTable.key, `session/state-checkpoint/${sessionID}/%`)).run().pipe(Effect.orDie)
      const text = make(fixture)
      summary = text
      expect(yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(sessionID), [fixture.grant, fixture.answer]) })).toEqual({
        status: "completed",
      })
      expect(yield* SessionStateCheckpoint.engaged(fixture.db, sessionID)).toBe(false)
      const history = yield* SessionHistory.load(fixture.db, sessionID, "local")
      // The ordinary summary starts its window: the session's earlier rows are not retained as a typed tail.
      expect(history.map((message) => message.type)).toEqual(["compaction"])
      expect(history[0]).toMatchObject({ type: "compaction", status: "completed", summary: text })
      // The next compaction is the ordinary model summary, not a blocked recovery.
      expect(yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(sessionID), [user("again")]) })).toEqual({ status: "completed" })
    }
    // The genuinely bound checkpoint fails closed when its text no longer decodes against its binding, whether
    // damaged or carrying a version this core cannot read, with or without its local receipt.
    const [marker] = yield* compactionRows(other)
    for (const damaged of [copiedText.replace('version="1"', 'version="2"'), "<controller-state damaged"]) {
      yield* source.db
        .update(SessionMessageTable)
        .set({ data: { ...(marker!.data as object), summary: damaged } as never })
        .where(eq(SessionMessageTable.id, marker!.id))
        .run()
        .pipe(Effect.orDie)
      expect(yield* SessionHistory.load(source.db, other, "local").pipe(Effect.flip)).toMatchObject({ _tag: "Session.MessageDecodeError" })
    }
    yield* source.db.delete(KVTable).where(like(KVTable.key, `session/state-checkpoint/${other}/%`)).run().pipe(Effect.orDie)
    expect(yield* SessionHistory.load(source.db, other, "local").pipe(Effect.flip)).toMatchObject({ _tag: "Session.MessageDecodeError" })
    expect(yield* SessionStateCheckpoint.engaged(source.db, other)).toBe(true)
    // Every ordinary summary came from the hook, so nothing reached the model.
    expect(requests).toHaveLength(0)
  }),
)

it.effect("one native shell intent authorises exactly one operation, claimed inside its transaction", () =>
  Effect.gen(function* () {
    const sessionID = Session.ID.make("ses_state_intent_race")
    const fixture = yield* armed(sessionID)
    yield* replace(sessionID, assistant([call("call_state", "controller_state", done("ok"))], true, fixture.tool.id))
    yield* block(fixture.db, sessionID)
    yield* append(sessionID, [shell(SessionStateCheckpoint.intent("snapshot", 1))])
    const admit = yield* inboxAdmit()
    const store = yield* SessionStore.Service
    const get = (id: Session.ID) => store.get(id).pipe(Effect.flatMap((found) => (found ? Effect.succeed(found) : Effect.die(id))))
    // Both calls pass the pre-check, then enter their transactions together.
    const both = yield* Deferred.make<void>()
    let entered = 0
    const delayed = new Proxy(fixture.db, {
      get(target, property) {
        // oxlint-disable-next-line no-restricted-globals -- Genuine proxy reflection: every non-transaction member keeps its original behaviour.
        if (property !== "transaction") return Reflect.get(target, property)
        return (...args: Parameters<typeof target.transaction>) =>
          Effect.gen(function* () {
            entered++
            if (entered === 2) yield* Deferred.succeed(both, undefined)
            yield* Deferred.await(both)
            return yield* target.transaction(...args)
          })
      },
    })
    const results = yield* Effect.all(
      Array.from({ length: 2 }, () =>
        SessionStateCheckpoint.maintainFor(delayed, { get, compact: admit }, { sessionID, operation: "snapshot", expectedRevision: 1 }),
      ),
      { concurrency: 2 },
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({ error: "intent_required", intent: SessionStateCheckpoint.intent("snapshot", 1) })

    // A failed operation leaves its intent unused for the corrected retry.
    const snap = results.find((result) => result.ok)
    if (!snap?.ok || !("snapshotID" in snap) || !snap.coverage || !snap.snapshotID) return yield* Effect.die(snap)
    const state = reviewed(sessionID, snap.coverage, { sessionID, messageID: fixture.answer.id }, { authority: fixture.state.authority })
    const hash = SessionStateEnvelope.stateHash(state)
    yield* append(sessionID, [shell(SessionStateCheckpoint.intent("update", 1, hash))])
    const update = (snapshotID: string) =>
      SessionStateCheckpoint.maintainFor(fixture.db, { get, compact: admit }, { sessionID, operation: "update", expectedRevision: 1, snapshotID, state })
    expect(yield* update("scp_unknown")).toMatchObject({ ok: false, error: "snapshot_invalid" })
    expect(yield* update(snap.snapshotID)).toMatchObject({ ok: true, receipt: { revision: 2 } })
    expect(yield* update(snap.snapshotID)).toMatchObject({ ok: false, error: "stale_revision" })
  }),
)

it.effect("a checkpoint keeps a multipart and native-control suffix exactly; media or opaque context blocks it unsized", () =>
  Effect.gen(function* () {
    requests = []
    yield* echo([])
    const suffixed = Effect.fnUntraced(function* (sessionID: Session.ID, sized: boolean) {
      const fixture = yield* armed(sessionID)
      const requestID = yield* request(fixture, sessionID)
      const settled = assistant([call("call_state", "controller_state", done(`Bound ${LONG}`))], true, fixture.tool.id)
      yield* replace(sessionID, settled)
      const suffix = [
        Schema.decodeUnknownSync(SessionMessage.User)({
          id: SessionMessage.ID.create(),
          type: "user",
          text: `See the attachment ${LONG}`,
          ...(sized ? {} : { files: [{ data: "iVBORw0KGgo=", mime: "image/png", source: { type: "inline" }, name: "pixel.png" }] }),
          time: { created: 0 },
        }),
        assistant([
          ...(sized ? [] : [{ type: "reasoning", text: "Private reasoning", native: { encrypted_content: "opaque-provider-blob==" } }]),
          text(`Answer ${LONG}`),
          call("call_read_more", "read", done(`Read ${LONG}`)),
        ]),
        Schema.decodeUnknownSync(SessionMessage.Synthetic)({ id: SessionMessage.ID.create(), type: "synthetic", text: "Completed job receipt", time: { created: 0 } }),
        Schema.decodeUnknownSync(SessionMessage.Info)({ id: SessionMessage.ID.create(), type: "agent-switched", agent: Agent.defaultID, time: { created: 0 } }),
      ] as SessionMessage.Info[]
      yield* append(sessionID, suffix)
      return { fixture, outcome: yield* manual(yield* session(sessionID), [], requestID), tail: [settled, ...suffix] }
    })

    const sized = yield* suffixed(Session.ID.make("ses_state_suffix"), true)
    expect(sized.outcome).toEqual({ status: "completed" })
    expect((yield* SessionHistory.load(sized.fixture.db, Session.ID.make("ses_state_suffix"), "local")).slice(1)).toEqual(sized.tail)

    // The existing guard cannot size media or opaque provider context locally: the checkpoint blocks before commit,
    // with nothing clipped, summarised or consumed, and the original messages remain the history.
    const unsized = Session.ID.make("ses_state_unsized")
    const blocked = yield* suffixed(unsized, false)
    expect(blocked.outcome).toMatchObject({ status: "failed", error: { type: "state-checkpoint.blocked", message: expect.stringContaining("no trustworthy local size") } })
    const history = yield* SessionHistory.load(blocked.fixture.db, unsized, "local")
    expect(history.some((message) => message.type === "compaction" && message.status === "completed")).toBe(false)
    const originals = history.filter((message) => message.type !== "compaction")
    expect(originals.slice(-blocked.tail.length)).toEqual(blocked.tail as typeof originals)
    const status = yield* statusOf(blocked.fixture.db, unsized)
    expect(status.ok && status.current?.consumed).toBeUndefined()
    expect(requests).toEqual([])
  }),
)

it.effect("a staged revert blocks the snapshot and the checkpoint", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    yield* echo([])

    const reverted = Session.ID.make("ses_state_revert")
    const staged = yield* armed(reverted)
    yield* staged.db.update(SessionTable).set({ revert: { messageID: staged.answer.id } as never }).where(eq(SessionTable.id, reverted)).run().pipe(Effect.orDie)
    expect(yield* SessionStateCheckpoint.snapshot(staged.db, { sessionID: reverted, source: staged.source })).toMatchObject({ ok: false, error: "unsettled" })
    expect(yield* compaction.compact({ reason: "overflow", context: loaded(yield* session(reverted), []) })).toMatchObject({
      status: "failed",
      error: { type: "state-checkpoint.blocked", message: expect.stringContaining("revert") },
    })

    const status = yield* statusOf(staged.db, reverted)
    expect(status.ok && status.current?.consumed).toBeUndefined()
    expect(requests).toEqual([])
  }),
)
