import type { FileSystem } from "@opencode/core/filesystem"
import { describe, expect } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instance } from "@opencode/core/instance/service"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionNativeTest } from "@opencode/core/session/native-test"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Context, DateTime, Deferred, Effect, Exit, Layer, LayerMap, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"
import { SubagentJob } from "@opencode/core/session/subagent-job"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      SessionInbox.node,
      SessionProjector.node,
      Job.node,
      SessionNativeTest.node,
      SessionModelTransport.node,
    ]),
  ),
)

type SessionID = SessionSchema.ID
type Drain = (input: Parameters<SessionRunner.Interface["drain"]>[0]) => Effect.Effect<void, SessionRunner.RunError>

const recoveryOf = (parent: SessionID, child: SessionID, description: string) => ({
  kind: "subagent" as const,
  parentSessionID: parent,
  childSessionID: child,
  agent: "explore",
  description,
})

describe("fork task controls on upstream subagent reports", () => {
  // SessionTaskControl.cancelEntry order: jobs.cancel(id, { suppress: true }), then execution.interrupt(child).
  it.live(
    "task_cancel of a running child leaves no report in the parent (50 rounds)",
    () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const jobs = yield* Job.Service
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const started = new Map<string, Deferred.Deferred<void>>()
        const context = yield* buildExecution(scope, ({ sessionID }) => {
          const gate = started.get(sessionID)
          return gate ? Deferred.succeed(gate, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void
        })
        const execution = Context.get(context, SessionExecution.Service)
        const leaked: string[] = []
        for (let round = 0; round < 50; round++) {
          const parent = sessionID(`ses_cancel_parent_${round}`)
          const child = sessionID(`ses_cancel_child_${round}`)
          yield* seedSessions(database, [parent])
          yield* seedSessions(database, [child], { parent_id: parent, agent: "explore", title: "Cancelled" })
          yield* seedAssistant(database, child, 100, "partial")
          const gate = yield* Deferred.make<void>()
          started.set(child, gate)
          const job = yield* SubagentJob.start(jobs, execution, recoveryOf(parent, child, "Cancelled"))
          yield* Deferred.await(gate)
          yield* jobs.cancel(job.id, { suppress: true })
          yield* execution.interrupt(child)
          yield* execution.awaitIdle(child)
          yield* Effect.sleep("20 millis")
          const inbox = yield* SessionInbox.list(database.db, parent)
          if (inbox.length > 0) leaked.push(`${round}:${text(inbox[0]).split("\n")[0]}`)
        }
        expect(leaked).toEqual([])
      }),
    30_000,
  )

  it.live("a suppressed child prompted again later still reports its new period", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const inbox = yield* SessionInbox.Service
      const parent = sessionID("ses_resup_parent")
      const child = sessionID("ses_resup_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, agent: "explore", title: "Resumed" })
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        sessionID === child && calls++ === 0
          ? Deferred.succeed(gate, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      )
      const execution = Context.get(context, SessionExecution.Service)
      const job = yield* SubagentJob.start(jobs, execution, recoveryOf(parent, child, "Resumed"))
      yield* Deferred.await(gate)
      yield* jobs.cancel(job.id, { suppress: true })
      yield* execution.interrupt(child)
      yield* execution.awaitIdle(child)
      expect(yield* SessionInbox.list(database.db, parent)).toEqual([])
      // Later, someone sends the cancelled child a new prompt (send_message, user in child view).
      yield* seedAssistant(database, child, 5000, "Later answer")
      yield* inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID: child,
        item: { type: "user", payload: { text: "Carry on" }, delivery: "steer" },
      })
      yield* execution.wake(child)
      yield* execution.awaitIdle(child)
      const reports = yield* SessionInbox.list(database.db, parent)
      expect(reports.map((item) => text(item).split("\n")[1])).toEqual(["Later answer"])
    }),
  )

  it.live("CONTROL: an unsuppressed cancelled child prompted again reports both periods", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const inbox = yield* SessionInbox.Service
      const parent = sessionID("ses_ctl_parent")
      const child = sessionID("ses_ctl_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, agent: "explore", title: "Resumed" })
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const gate = yield* Deferred.make<void>()
      let calls = 0
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        sessionID === child && calls++ === 0
          ? Deferred.succeed(gate, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      )
      const execution = Context.get(context, SessionExecution.Service)
      const job = yield* SubagentJob.start(jobs, execution, recoveryOf(parent, child, "Resumed"))
      yield* Deferred.await(gate)
      yield* jobs.cancel(job.id)
      yield* execution.interrupt(child)
      yield* execution.awaitIdle(child)
      expect((yield* SessionInbox.list(database.db, parent)).length).toBe(1)
      // Later, someone sends the cancelled child a new prompt (send_message, user in child view).
      yield* seedAssistant(database, child, 5000, "Later answer")
      yield* inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID: child,
        item: { type: "user", payload: { text: "Carry on" }, delivery: "steer" },
      })
      yield* execution.wake(child)
      yield* execution.awaitIdle(child)
      const reports = yield* SessionInbox.list(database.db, parent)
      expect(reports.map((item) => text(item).split("\n")[1])).toEqual(["Subagent cancelled", "Later answer"])
    }),
  )

  // Exact stopResponse/resume order: jobs.pause(parent) ... jobs.unpause(parent) then execution.wake(parent).
  it.live("a paused parent retains a child report without waking and drains it on resume", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const parent = sessionID("ses_pause_parent")
      const child = sessionID("ses_pause_child")
      yield* seedSessions(database, [parent])
      yield* seedSessions(database, [child], { parent_id: parent, agent: "explore", title: "Paused" })
      yield* seedAssistant(database, child, 100, "Child done")
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const drained: string[] = []
      const context = yield* buildExecution(scope, ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)))
      const execution = Context.get(context, SessionExecution.Service)
      yield* jobs.pause(parent)
      yield* SubagentJob.start(jobs, execution, recoveryOf(parent, child, "Paused"))
      yield* execution.awaitIdle(child)
      yield* Effect.sleep("50 millis")
      yield* execution.awaitIdle(parent)
      expect(drained).toEqual([child])
      expect((yield* SessionInbox.list(database.db, parent)).map((item) => item.type)).toEqual(["synthetic"])
      yield* jobs.unpause(parent)
      yield* execution.wake(parent)
      yield* execution.awaitIdle(parent)
      expect(drained).toEqual([child, parent])
    }),
  )

  it.live("a worker woken by its reviewer's report acts, and its next period reaches its own parent once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const jobs = yield* Job.Service
      const root = sessionID("ses_chain_root")
      const worker = sessionID("ses_chain_worker")
      const reviewer = sessionID("ses_chain_reviewer")
      yield* seedSessions(database, [root])
      yield* seedSessions(database, [worker], { parent_id: root, agent: "Lister", title: "Worker" })
      yield* seedSessions(database, [reviewer], { parent_id: worker, agent: "Kryten", title: "Review" })
      yield* seedAssistant(database, worker, 100, "Dispatched reviewer")
      yield* seedAssistant(database, reviewer, 100, "Review passed")
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      let workerCalls = 0
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        sessionID === worker && workerCalls++ > 0
          ? seedAssistant(database, worker, 9000, "Acted on review")
          : Effect.void,
      )
      const execution = Context.get(context, SessionExecution.Service)
      yield* SubagentJob.start(jobs, execution, recoveryOf(root, worker, "Worker"))
      yield* execution.awaitIdle(worker)
      yield* SubagentJob.start(jobs, execution, recoveryOf(worker, reviewer, "Review"))
      yield* execution.awaitIdle(reviewer)
      yield* Effect.sleep("50 millis")
      yield* execution.awaitIdle(worker)
      yield* Effect.sleep("50 millis")
      const workerInbox = yield* SessionInbox.list(database.db, worker)
      const rootInbox = yield* SessionInbox.list(database.db, root)
      expect(workerInbox.map((item) => text(item).split("\n")[1])).toEqual(["Review passed"])
      expect(rootInbox.map((item) => text(item).split("\n")[1])).toEqual(["Dispatched reviewer", "Acted on review"])
      expect(workerCalls).toBe(2)
      expect(yield* jobs.pendingBackground).toEqual([])
    }),
  )
})

function sessionID(value: string): SessionID {
  return SessionSchema.ID.make(value)
}

function text(item: SessionInbox.Info | undefined) {
  if (item?.type !== "synthetic") return ""
  return item.payload.text
}

/** Builds the local execution layer against the harness services and a stubbed runner. */
function buildExecution(scope: Scope.Scope, drain: Drain) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const jobs = yield* Job.Service
    const inbox = yield* SessionInbox.Service
    const runner = Layer.succeed(
      SessionRunner.Service,
      SessionRunner.Service.of({
        drain: (input) => drain(input).pipe(Effect.as(SessionRunner.DrainResult.Complete())),
      }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          // The settlement test only needs the Session runner from the Location graph.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          runner as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      ),
    )
    return yield* Layer.buildWithScope(
      SessionExecution.layer.pipe(
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(Bus.Service, bus)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(SessionInbox.Service, inbox)),
        Layer.provide(Layer.succeed(Job.Service, jobs)),
        Layer.provide(
          AppNodeBuilder.build(Instance.node, [LocationServiceMap.node.replace(locations)]).pipe(Layer.fresh),
        ),
      ),
      scope,
    )
  })
}

type SeedValues = Partial<
  Pick<typeof SessionTable.$inferInsert, "time_suspended" | "resume_attempts" | "parent_id" | "title" | "revert">
> & { readonly agent?: string }

function seedSessions(
  database: Database.Service["Service"],
  sessionIDs: ReadonlyArray<SessionID>,
  values: SeedValues = {},
) {
  return Effect.gen(function* () {
    const { agent, ...rest } = values
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          ...rest,
          ...(agent ? { agent: Agent.ID.make(agent) } : {}),
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

const encodeMessage = Schema.encodeSync(SessionMessage.Info)

function seedAssistant(database: Database.Service["Service"], sessionID: SessionID, seq: number, text: string) {
  const id = SessionMessage.ID.make(`msg_seed_${sessionID}_${seq}`)
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: Agent.ID.make("build"),
      model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
      content: [SessionMessage.AssistantText.make({ type: "text", text })],
      time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
    }),
  )
  return database.db
    .insert(SessionMessageTable)
    .values({ id, session_id: sessionID, type, seq, time_created: 0, data })
    .run()
    .pipe(Effect.orDie)
}


