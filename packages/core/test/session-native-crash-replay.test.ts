import { expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Bus } from "../src/bus.js"
import { Database } from "../src/database/database.js"
import { AppNodeBuilder } from "../src/effect/app-node-builder.js"
import { ProjectTable } from "../src/project/sql.js"
import { SessionEvent } from "../src/session/event.js"
import { SessionHistory } from "../src/session/history.js"
import { SessionMessage } from "../src/session/message.js"
import { SessionProjector } from "../src/session/projector.js"
import { toLLMMessages } from "../src/session/runner/to-llm-message.js"
import { SessionMessageTable, SessionTable } from "../src/session/sql.js"
import { testEffect } from "./lib/effect.js"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node])))
const model = Schema.decodeUnknownSync(Model.Ref)({ id: "fixture", providerID: "openai" })
const switched = Schema.decodeUnknownSync(Model.Ref)({ id: "other", providerID: "openai" })
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const sessionID = Session.ID.create()
  const assistantMessageID = SessionMessage.ID.create()
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] }).onConflictDoNothing().run()
  yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "native-crash", directory: "/fixture", version: "test" }).run()
  const base = { sessionID, assistantMessageID }
  yield* bus.publish(SessionEvent.Step.Started, { ...base, agent: Agent.ID.make("build"), model, started: 0 })
  const replay = Effect.gen(function* () {
    const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get()
    const message = yield* SessionHistory.decodeMessageRow(row!)
    expect(message).not.toHaveProperty("finish")
    expect(message).not.toHaveProperty("error")
    return { same: JSON.stringify(toLLMMessages([message], model, "openai")), switched: JSON.stringify(toLLMMessages([message], switched, "openai")) }
  })
  return { bus, base, replay }
})

it.effect("native crash before reasoning acknowledgement excludes added proof entirely", () => Effect.gen(function* () {
  const { bus, base, replay } = yield* setup
  yield* bus.publish(SessionEvent.Reasoning.Started, { ...base, ordinal: 0, native: { itemId: "rs_same", reasoningEncryptedContent: "UNACKNOWLEDGED_ADDED_PROOF" } })
  yield* bus.publish(SessionEvent.Step.Observed, { ...base, native: { nativeObserved: true, completedOutputItems: [], unresolvedHostedItems: [] } })
  const result = yield* replay
  expect(result.same).not.toContain("UNACKNOWLEDGED_ADDED_PROOF")
  expect(result.same).not.toContain("rs_same")
  expect(result.switched).not.toContain("UNACKNOWLEDGED_ADDED_PROOF")
}))

it.effect("native done observation before display replaces added proof, including missing proof and model switches", () => Effect.gen(function* () {
  const { bus, base, replay } = yield* setup
  yield* bus.publish(SessionEvent.Reasoning.Started, { ...base, ordinal: 0, native: { itemId: "rs_same", reasoningEncryptedContent: "UNACKNOWLEDGED_ADDED_PROOF" } })
  const done = { type: "reasoning", id: "rs_same", summary: [{ type: "summary_text", text: "Acknowledged summary" }] }
  yield* bus.publish(SessionEvent.Step.Observed, { ...base, native: { nativeObserved: true, completedOutputItems: [{ ...done, encrypted_content: "ACKNOWLEDGED_DONE_PROOF" }], unresolvedHostedItems: [] } })
  // No Reasoning.Ended: the inventory transaction precedes display publication.
  const result = yield* replay
  expect(result.same).toContain("Acknowledged summary")
  expect(result.same).toContain("ACKNOWLEDGED_DONE_PROOF")
  expect(result.same).not.toContain("UNACKNOWLEDGED_ADDED_PROOF")
  expect(result.switched).toContain("Acknowledged summary")
  expect(result.switched).not.toContain("ACKNOWLEDGED_DONE_PROOF")
  expect(result.switched).not.toContain("UNACKNOWLEDGED_ADDED_PROOF")
  yield* bus.publish(SessionEvent.Step.Observed, { ...base, native: { completedOutputItems: [done] } })
  const missing = yield* replay
  expect(missing.same).toContain("Acknowledged summary")
  expect(missing.same).not.toContain("UNACKNOWLEDGED_ADDED_PROOF")
  expect(missing.same).not.toContain("ACKNOWLEDGED_DONE_PROOF")
  for (const value of [result.same, result.switched, missing.same, missing.switched]) {
    expect(value).toContain(`"type":"reasoning","text":"Acknowledged summary"`)
    expect(value).not.toContain(`"type":"text","text":"Acknowledged summary"`)
  }
}))

it.effect("native done receipt without a display part recovers structured reasoning across model switches", () => Effect.gen(function* () {
  const { bus, base, replay } = yield* setup
  const done = { type: "reasoning", id: "rs_receipt", summary: [{ type: "summary_text", text: "Receipt summary" }], encrypted_content: "RECEIPT_PROOF" }
  yield* bus.publish(SessionEvent.Step.Observed, { ...base, native: { nativeObserved: true, completedOutputItems: [done], unresolvedHostedItems: [] } })
  const result = yield* replay
  expect(result.same).toContain(`"type":"reasoning","text":"Receipt summary"`)
  expect(result.same).toContain("RECEIPT_PROOF")
  expect(result.switched).toContain(`"type":"reasoning","text":"Receipt summary"`)
  expect(result.switched).not.toContain("RECEIPT_PROOF")
  for (const value of [result.same, result.switched]) expect(value).not.toContain(`"type":"text","text":"Receipt summary"`)
}))

it.effect("native crash excludes unowned fragments but retains owned calls, results and model-scoped proof", () => Effect.gen(function* () {
  const { bus, base, replay } = yield* setup
  yield* bus.publish(SessionEvent.Tool.Input.Started, { ...base, id: "unowned_fragment", name: "external_write" })
  yield* bus.publish(SessionEvent.Tool.Input.Ended, { ...base, id: "unowned_fragment", text: '{"unfinished":' })
  yield* bus.publish(SessionEvent.Tool.Failed, { ...base, id: "unowned_fragment", executed: false, error: { type: "tool.superseded", message: "Unowned fragment" } })
  for (const id of ["owned_done", "owned_before_provider_done"]) {
    yield* bus.publish(SessionEvent.Tool.Input.Started, { ...base, id, name: "external_write" })
    yield* bus.publish(SessionEvent.Tool.Called, { ...base, id, input: { binding: id }, executed: false, native: { itemId: id, proof: "OWNED_CALL_PROOF" } })
    yield* bus.publish(SessionEvent.Tool.Success, { ...base, id, executed: false, content: [{ type: "text", text: `Result for ${id}` }] })
  }
  yield* bus.publish(SessionEvent.Step.Observed, { ...base, native: {
    nativeObserved: true,
    completedOutputItems: [{ type: "function_call", id: "owned_done", call_id: "owned_done", name: "external_write", arguments: '{"binding":"owned_done"}' }],
    unresolvedHostedItems: [{ type: "mcp_call", id: "unknown_hosted" }],
  } })
  const result = yield* replay
  for (const value of [result.same, result.switched]) {
    expect(value).not.toContain("unowned_fragment")
    expect(value).not.toContain("unfinished")
    expect(value).toContain("Result for owned_done")
    expect(value).toContain("Result for owned_before_provider_done")
    expect(value).toContain("external outcome is unknown")
    expect(value).toContain("unknown_hosted")
  }
  expect(result.same).toContain("OWNED_CALL_PROOF")
  expect(result.switched).not.toContain("OWNED_CALL_PROOF")
}))
