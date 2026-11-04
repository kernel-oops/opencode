import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { KVTable } from "@opencode/core/kv/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

it.effect("USER admission revision survives database reopen without retained bus payloads", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const sessionID = Session.ID.create()
    const id = SessionMessage.ID.create()
    const graph = () =>
      AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
        Database.node.replace(Database.configured({ path: `${tmp.path}/fixture.sqlite` })),
        Bus.node.replace(Bus.configured({ persist: false })),
      ]).pipe(Layer.fresh)
    const revision = Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db
        .select()
        .from(KVTable)
        .where(eq(KVTable.key, SessionInbox.userAdmissionKey(sessionID)))
        .get()
        .pipe(Effect.orDie))?.value
    })
    yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          directory: tmp.path,
          slug: "revision",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const inbox = yield* SessionInbox.make()
      expect(yield* revision).toBeUndefined()
      yield* inbox.admit({ id, sessionID, item: { type: "user", delivery: "queue", payload: { text: "STOP" } } })
      expect(yield* revision).toBe(0)
      yield* inbox.admit({
        id,
        sessionID,
        item: { type: "user", delivery: "steer", payload: { text: "ignored retry" } },
      })
      expect(yield* revision).toBe(0)
      yield* inbox.cancel({ id, sessionID })
      expect(yield* revision).toBe(0)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }).pipe(Effect.scoped, Effect.provide(graph()))
    yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      const inbox = yield* SessionInbox.make()
      expect(yield* revision).toBe(0)
      expect(yield* inbox.list(sessionID)).toHaveLength(0)
      yield* inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID,
        item: { type: "synthetic", delivery: "steer", payload: { text: "peer input" } },
      })
      expect(yield* revision).toBe(0)
      yield* inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID,
        item: { type: "user", delivery: "steer", payload: { text: "new admission" } },
      })
      expect(yield* revision).toBe(3)
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }).pipe(Effect.scoped, Effect.provide(graph()))
  }),
)
