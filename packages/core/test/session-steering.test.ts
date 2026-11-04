import { expect } from "bun:test"
import { AIError, LanguageModel, ai, LLMEvent, TransportError } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStep } from "@opencode/core/session/runner/step"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { ToolOutput } from "@opencode/core/tool-output"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
  TestLLM.testLayer(),
  Layer.mock(Snapshot.Service)({ capture: () => Effect.succeed(undefined) }),
))

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const inbox = yield* SessionInbox.make()
  const llm = yield* TestLLM.Test
  const sessionID = Session.ID.create()
  const assistantMessageID = SessionMessage.ID.create()
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "steering", directory: "/project", version: "test" }).run()
  const model = SessionRunnerModel.resolved(LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 100_000, output: 1_000 },
    cost: [],
  })
  const correction = (id = SessionMessage.ID.create(), delivery: "steer" | "queue" = "steer") =>
    inbox.admit({ id, sessionID, item: { type: "user", payload: { text: "Correction" }, delivery } })
  const input = {
    isLocationClosed: () => false,
    sessionID,
    assistantMessageID,
    agent: Agent.defaultID,
    model,
    prepared: {
      retry: () => Effect.void,
      request: ai.request({ model: model.model, prompt: "Original" }),
      options: {},
      executeTool: () => Effect.succeed({ content: [{ type: "text" as const, text: "Ran" }] }),
    },
    retry: () => Effect.succeed({ retry: false as const }),
    recoverContinuation: true,
    recoverOverflow: Effect.succeed(false),
  }
  const message = db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get()
  return { db, inbox, llm, sessionID, assistantMessageID, correction, input, message }
})

for (const control of ["compaction", "move"] as const) {
  for (const kind of ["user", "synthetic"] as const) {
    it.effect(`pending ${kind} steering behind ${control} never invalidates a generation`, () => Effect.gen(function* () {
      const s = yield* setup
      if (control === "compaction")
        yield* s.inbox.admitCompaction({ id: SessionMessage.ID.create(), sessionID: s.sessionID, delivery: "steer" })
      else yield* s.inbox.admit({ id: SessionMessage.ID.create(), sessionID: s.sessionID, item: {
        type: "move", delivery: "steer", payload: { location: { directory: AbsolutePath.make("/moved") }, projectID: Project.ID.global },
      } })
      const controlsOnly = yield* SessionInbox.watch(s.db, s.sessionID)
      expect(controlsOnly.invalidated()).toBe(false)
      yield* s.inbox.admit({ id: SessionMessage.ID.create(), sessionID: s.sessionID, item: {
        type: kind, delivery: "steer", payload: { text: "Correction" },
      } })
      expect(controlsOnly.invalidated()).toBe(false)
      const newlyRegistered = yield* SessionInbox.watch(s.db, s.sessionID)
      expect(newlyRegistered.invalidated()).toBe(false)
    }))
  }
}

it.effect("steering allows a published tool to acquire ordinary dispatch ownership", () => Effect.gen(function* () {
  const s = yield* setup
  const bus = yield* Bus.Service
  let executions = 0
  const steps = yield* SessionStep.make.pipe(Effect.provideService(Bus.Service, {
    ...bus,
    publish: (event, data, metadata) => bus.publish(event, data, metadata).pipe(Effect.tap(() =>
      event.type === SessionEvent.Tool.Called.type ? s.correction().pipe(Effect.asVoid) : Effect.void)),
  }))
  yield* s.llm.push(TestLLM.toolCall("refused", "test", {}))
  const outcome = yield* steps.attempt({ ...s.input, prepared: { ...s.input.prepared, executeTool: () => Effect.sync(() => {
    executions++
    return { content: [{ type: "text", text: "Ran normally" }] }
  }) } })
  expect(outcome._tag).not.toBe("Steered")
  expect(executions).toBe(1)
  expect((yield* s.message)?.data).not.toHaveProperty("interruption")
}))

it.effect("steering pending during preparation does not cancel the prepared model request", () => Effect.gen(function* () {
  const s = yield* setup
  yield* s.correction()
  const steps = yield* SessionStep.make
  yield* s.llm.push(TestLLM.stop())
  expect((yield* steps.attempt(s.input))._tag).not.toBe("Steered")
  expect(yield* s.llm.requests()).toHaveLength(1)
}))

it.effect("steering gates ignore controls, queue and duplicate identities, and close eligibility on completion", () => Effect.gen(function* () {
  const s = yield* setup
  const queued = yield* s.correction(undefined, "queue")
  const gate = yield* SessionInbox.watch(s.db, s.sessionID)
  yield* s.inbox.admitCompaction({ id: SessionMessage.ID.create(), sessionID: s.sessionID, delivery: "steer" })
  yield* s.correction(queued.id, "steer")
  expect(gate.invalidated()).toBe(false)
  yield* s.inbox.steer({ id: queued.id, sessionID: s.sessionID })
  expect(gate.invalidated()).toBe(false)
  expect(Option.isSome(yield* gate.guard(Effect.succeed("allowed")))).toBe(true)
  yield* s.inbox.queue({ id: queued.id, sessionID: s.sessionID })
  expect(gate.invalidated()).toBe(false)
  const next = yield* SessionInbox.watch(s.db, s.sessionID)
  yield* next.finish
  yield* s.correction()
  expect(next.invalidated()).toBe(false)
}))

it.effect("steering conflicting admissions do not invalidate a generation", () => Effect.gen(function* () {
  const s = yield* setup
  const id = SessionMessage.ID.create()
  yield* s.inbox.admit({ id, sessionID: s.sessionID, item: { type: "synthetic", payload: { text: "Queued" }, delivery: "queue" } })
  const gate = yield* SessionInbox.watch(s.db, s.sessionID)
  expect(Exit.isFailure(yield* s.correction(id).pipe(Effect.exit))).toBe(true)
  expect(gate.invalidated()).toBe(false)
  yield* s.inbox.cancel({ id, sessionID: s.sessionID })
  expect(gate.invalidated()).toBe(false)
}))

it.effect("steering leaves a blocked generation and its observed usage intact until completion", () => Effect.gen(function* () {
  const s = yield* setup
  const paused = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const cancelled = yield* Deferred.make<void>()
  yield* s.llm.push(Stream.concat(
    Stream.fromIterable(TestLLM.complete({ reason: { normalized: "stop" }, usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 4 } })),
    Stream.fromEffect(Deferred.succeed(paused, undefined)).pipe(Stream.flatMap(() => Stream.fromEffect(Deferred.await(release))), Stream.flatMap(() => Stream.empty)),
  ).pipe(Stream.ensuring(Deferred.succeed(cancelled, undefined))))
  const steps = yield* SessionStep.make
  const run = yield* steps.attempt(s.input).pipe(Effect.forkChild)
  yield* Deferred.await(paused)
  yield* s.correction()
  expect(yield* Deferred.isDone(cancelled)).toBe(false)
  yield* Deferred.succeed(release, undefined)
  expect((yield* Fiber.join(run))._tag).not.toBe("Steered")
  expect((yield* s.message)?.data).toMatchObject({ finish: "stop", tokens: { input: 10, output: 4 } })
  expect((yield* s.message)?.data).not.toHaveProperty("interruption")
}))

it.effect("steering cannot swallow a simultaneous provider failure", () => Effect.gen(function* () {
  const s = yield* setup
  const bus = yield* Bus.Service
  const failure = new AIError({ reason: new TransportError({ message: "Provider failed", transport: "http", operation: "read" }) })
  const steps = yield* SessionStep.make.pipe(Effect.provideService(Bus.Service, {
    ...bus,
    publish: (event, data, metadata) => bus.publish(event, data, metadata).pipe(Effect.tap(() =>
      event.type === SessionEvent.Text.Ended.type ? s.correction().pipe(Effect.asVoid) : Effect.void)),
  }))
  yield* s.llm.push(TestLLM.failAfter(failure, LLMEvent.textStart({ id: "partial" }), LLMEvent.textDelta({ id: "partial", text: "Partial" })))
  const result = yield* steps.attempt(s.input).pipe(Effect.exit)
  expect(Exit.isFailure(result)).toBe(true)
  expect((yield* s.message)?.data).toMatchObject({ finish: "error", error: { message: "Provider failed" } })
  expect((yield* s.message)?.data).not.toHaveProperty("interruption")
}))

it.effect("steering cannot swallow an already-owned tool defect", () => Effect.gen(function* () {
  const s = yield* setup
  const owned = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const defect = new Error("Owned tool defect")
  yield* s.llm.push(TestLLM.toolCall("owned", "test", {}))
  const steps = yield* SessionStep.make
  const run = yield* steps.attempt({ ...s.input, prepared: { ...s.input.prepared, executeTool: () =>
    Deferred.succeed(owned, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.die(defect))),
  } }).pipe(Effect.forkChild)
  yield* Deferred.await(owned)
  yield* s.correction()
  yield* Deferred.succeed(release, undefined)
  const result = yield* Fiber.await(run)
  expect(Exit.isSuccess(result)).toBe(true)
  expect((yield* s.message)?.data).not.toHaveProperty("interruption")
  expect((yield* s.message)?.data).toMatchObject({ content: [{ state: { status: "error", error: { message: "Owned tool defect" } } }] })
}))

it.effect("explicit interruption still cancels the model and owned tools after steering", () => Effect.gen(function* () {
  const s = yield* setup
  const owned = yield* Deferred.make<void>()
  const toolCancelled = yield* Deferred.make<void>()
  const modelCancelled = yield* Deferred.make<void>()
  yield* s.llm.push(TestLLM.hangAfter(LLMEvent.toolCall({ id: "owned", name: "test", input: {} })).pipe(Stream.ensuring(Deferred.succeed(modelCancelled, undefined))))
  const steps = yield* SessionStep.make
  const run = yield* steps.attempt({ ...s.input, prepared: { ...s.input.prepared, executeTool: () =>
    Deferred.succeed(owned, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Deferred.succeed(toolCancelled, undefined))),
  } }).pipe(Effect.forkChild)
  yield* Deferred.await(owned)
  yield* s.correction()
  expect(yield* Deferred.isDone(modelCancelled)).toBe(false)
  yield* Fiber.interrupt(run)
  expect(yield* Deferred.isDone(modelCancelled)).toBe(true)
  expect(yield* Deferred.isDone(toolCancelled)).toBe(true)
  expect((yield* s.message)?.data).not.toHaveProperty("interruption")
  expect((yield* s.message)?.data).toMatchObject({ finish: "error", error: { type: "aborted" } })
}))
