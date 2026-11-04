import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ToolFailure } from "@opencode/ai/effect"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import { execute } from "@opencode/core/tool/runtime"
import { Tool } from "@opencode/core/tool"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionTable } from "@opencode/core/permission/sql"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { SessionDelegation } from "@opencode/core/session/delegation"
import { NewSessionTable } from "@opencode/core/session/new-session.sql"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionProjector } from "@opencode/core/session/projector"
import { KVTable } from "@opencode/core/kv/sql"
import { InstructionEntryTable, InstructionStateTable, SessionMessageTable } from "@opencode/core/session/sql"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { ShellParse } from "@opencode/core/shell/parse"
import { eq } from "drizzle-orm"
import { location, tempLocationLayer } from "./fixture/location"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      SessionProjector.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
    ]),
    [Location.node.replace(current)],
  ),
)
const ceilingIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      SessionProjector.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
      Location.node,
    ]),
    [
      Location.node.replace(
        Layer.effect(
          Location.Service,
          Effect.gen(function* () {
            const value = yield* Location.Service
            const id = yield* Effect.promise(async () => {
              const git = promisify(execFile)
              await git("git", ["init", "--quiet", value.directory])
              await git("git", [
                "-C",
                value.directory,
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "Fixture",
              ])
              return (await git("git", ["-C", value.directory, "rev-list", "--max-parents=0", "HEAD"])).stdout.trim()
            })
            return {
              ...value,
              project: { ...value.project, id: Project.ID.make(id) },
            }
          }),
        ).pipe(Layer.provide(tempLocationLayer)),
      ),
    ],
  ),
)

const delegated = Effect.gen(function* () {
  yield* setup([{ action: "*", resource: "*", effect: "allow" }])
  const { db } = yield* Database.Service
  const directory = (yield* Location.Service).directory
  const projectID = (yield* Location.Service).project.id
  yield* db.insert(ProjectTable).values({ id: projectID, worktree: directory, sandboxes: [] }).run().pipe(Effect.orDie)
  const info = yield* Effect.promise(() => stat(directory))
  yield* db
    .update(SessionTable)
    .set({ directory, project_id: projectID })
    .where(eq(SessionTable.id, Session.ID.make("ses_test")))
    .run()
    .pipe(Effect.orDie)
  const creator = Session.ID.make("ses_creator")
  yield* db
    .insert(NewSessionTable)
    .values({
      id: "fixture",
      creator_id: creator,
      launch_key: "fixture",
      payload_hash: "fixture",
      payload: "{}",
      project_id: projectID,
      ownership_key: "fixture",
      canonical: directory,
      workdir: directory,
      directory_identity: `${info.dev}:${info.ino}`,
      session_id: Session.ID.make("ses_test"),
      prompt_id: SessionMessage.ID.make("msg_fixture_prompt"),
      notification_id: SessionMessage.ID.make("msg_fixture_notification"),
      stage: "running",
      time_created: 0,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: creator,
      project_id: projectID,
      slug: "creator",
      directory,
      title: "creator",
      version: "test",
      agent: Agent.ID.make("test"),
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionDelegation.Table)
    .values({
      session_id: Session.ID.make("ses_test"),
      origin_id: Session.ID.make("ses_test"),
      creator_id: creator,
      source_agent: Agent.ID.make("test"),
      source_directory: directory,
      source_directory_identity: `${info.dev}:${info.ino}`,
      agent_rules: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "deny" },
      ],
      session_rules: [{ action: "*", resource: "*", effect: "allow" }],
      target_agent: Agent.ID.make("test"),
      target_model: Model.Ref.make({ id: Model.ID.make("fake"), providerID: Provider.ID.make("fake") }),
    })
    .run()
    .pipe(Effect.orDie)
  return { db, creator }
})

describe("immutable delegated permission ceilings", () => {
  ceilingIt.effect("refusals identify missing creator and workdir", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      const service = yield* Permission.Service
      const directory = (yield* Location.Service).directory
      yield* db.delete(SessionTable).where(eq(SessionTable.id, creator)).run().pipe(Effect.orDie)
      yield* db.update(NewSessionTable).set({ workdir: `${directory}/missing` }).run().pipe(Effect.orDie)
      const blocked = yield* service.assert(assertion({ action: "read" })).pipe(Effect.flip)
      expect(blocked.message).toContain(`creator session ${creator} no longer exists`)
      expect(blocked.message).toContain(`workdir ${directory}/missing missing or replaced (expected dev:ino`)
      expect(blocked.message).toContain("found missing)")
    }),
  )
  ceilingIt.effect("refusals identify delegated agent rule and new session prohibition", () =>
    Effect.gen(function* () {
      yield* delegated
      const service = yield* Permission.Service
      const blocked = yield* service.assert(assertion({ action: "shell", resources: ["echo hello"] })).pipe(Effect.flip)
      expect(blocked.message).toBe("Permission denied: shell (delegated agent rules: shell echo hello denied by rule shell *)")
      const launch = yield* service.assert(assertion({ action: "new_session" })).pipe(Effect.flip)
      expect(launch.message).toBe("Permission denied: new_session (delegated sessions cannot create new sessions)")
    }),
  )
  for (const pass of ["target", "source"] as const) {
    ceilingIt.effect(`delegated assert ${pass} review allows concurrent input without creating a request`, () =>
      Effect.gen(function* () {
        const { db, creator } = yield* delegated
        yield* db
          .update(SessionDelegation.Table)
          .set({ agent_rules: [{ action: "read", resource: "*", effect: "ask" }] })
          .run()
          .pipe(Effect.orDie)
        const hooks = yield* PluginHooks.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* hooks.register("permission", "evaluate", (event) =>
          Effect.gen(function* () {
            if (pass === "target") {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            event.effect = "allow"
          }),
        )
        yield* hooks.registerSourceReviewer((event) =>
          Effect.gen(function* () {
            if (pass === "source" && event.agent === "test") {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            event.effect = "allow"
          }),
        )
        const service = yield* Permission.Service
        const bus = yield* Bus.Service
        let asked = 0
        let effects = 0
        yield* bus.listen((event) =>
          Effect.sync(() => {
            if (event.type === Permission.Event.Asked.type) asked++
          }),
        )
        const run = yield* service.assert(assertion()).pipe(
          Effect.andThen(
            Effect.sync(() => {
              effects++
            }),
          ),
          Effect.forkScoped,
        )
        yield* Deferred.await(entered)
        const inbox = yield* SessionInbox.make()
        yield* inbox.admit({
          id: SessionMessage.ID.create(),
          sessionID: creator,
          item: { type: "user", delivery: "steer", payload: { text: "STOP" } },
        })
        yield* Deferred.succeed(release, undefined)
        const exit = yield* Fiber.await(run)
        expect(exit._tag).toBe("Success")
        expect(asked).toBe(0)
        expect(effects).toBe(1)
        expect(yield* service.list()).toEqual([])
        expect(yield* inbox.list(creator)).toHaveLength(1)
      }),
    )
  }
  ceilingIt.effect(
    "harmless redirected shell lookups can resolve a default source ask through authenticated Bash",
    () =>
      Effect.gen(function* () {
        const { db } = yield* delegated
        yield* db.update(SessionDelegation.Table).set({ agent_rules: [] }).run().pipe(Effect.orDie)
        const hooks = yield* PluginHooks.Service
        let bash = 0
        let luna = 0
        yield* hooks.registerSourceReviewer((event) =>
          Effect.sync(() => {
            bash++
            if (event.effect === "ask" && event.action === "shell") event.effect = "allow"
          }),
        )
        yield* hooks.registerSourceReviewer(() =>
          Effect.sync(() => {
            luna++
          }),
        )
        const service = yield* Permission.Service
        expect(
          (yield* service.ask(
            assertion({ action: "shell", resources: ["rg PHPsymbol /external/source > .logs/symbols.txt"] }),
          )).effect,
        ).toBe("allow")
        expect(bash).toBe(2)
        expect(luna).toBe(2)
      }),
  )
  ceilingIt.effect("authenticated source deny stays denied even if a later reviewer writes allow", () =>
    Effect.gen(function* () {
      const { db } = yield* delegated
      yield* db.update(SessionDelegation.Table).set({ agent_rules: [] }).run().pipe(Effect.orDie)
      const hooks = yield* PluginHooks.Service
      yield* hooks.registerSourceReviewer((event) =>
        Effect.sync(() => {
          if (event.agent) event.effect = "deny"
        }),
      )
      yield* hooks.registerSourceReviewer((event) =>
        Effect.sync(() => {
          event.effect = "allow"
        }),
      )
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("deny")
    }),
  )
  ceilingIt.effect("authenticated source review resolves generic asks with the real subject and creator agent", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "*", resource: "*", effect: "ask" }] })
        .where(eq(SessionTable.id, creator))
        .run()
        .pipe(Effect.orDie)
      const hooks = yield* PluginHooks.Service
      const observations: Array<{ agent?: string; sessionID: string; effect: string }> = []
      yield* hooks.registerSourceReviewer((event) =>
        Effect.sync(() => {
          observations.push({ agent: event.agent, sessionID: event.sessionID, effect: event.effect })
          // Fake Bash cannot decide a read; fake Luna handles the fresh source ask below.
        }),
      )
      yield* hooks.registerSourceReviewer((event) =>
        Effect.sync(() => {
          if (event.effect === "ask") event.effect = "allow"
        }),
      )
      const service = yield* Permission.Service
      const result = yield* service.ask(
        assertion({
          action: "read",
          resources: ["/external/PHP/symbols"],
          metadata: { purpose: "harmless symbol lookup" },
        }),
      )
      expect(result.effect).toBe("allow")
      expect(observations).toEqual([
        { agent: undefined, sessionID: "ses_test", effect: "allow" },
        { agent: "test", sessionID: "ses_test", effect: "ask" },
      ])
      expect(yield* service.list()).toEqual([])
    }),
  )
  ceilingIt.effect("source review cannot replace a genuine target ask or a source reviewer ask", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "ask" }] })
        .where(eq(SessionTable.id, creator))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "ask" }] })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const hooks = yield* PluginHooks.Service
      yield* hooks.registerSourceReviewer((event) =>
        Effect.sync(() => {
          if (event.agent === "test") event.effect = "allow"
        }),
      )
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("ask")
    }),
  )
  for (const pass of ["target", "source"] as const) {
    for (const field of [
      "title",
      "cost",
      "tokens",
      "updated",
      "viewed",
      "idle",
      "outcome",
      "metadata",
      "combined",
    ] as const) {
      ceilingIt.effect(`bookkeeping ${field} during ${pass} review preserves authenticated allow`, () =>
        Effect.gen(function* () {
          const { db, creator } = yield* delegated
          yield* db
            .update(SessionDelegation.Table)
            .set({
              agent_rules: [
                { action: "*", resource: "*", effect: "allow" },
                { action: "read", resource: "*", effect: "ask" },
              ],
            })
            .run()
            .pipe(Effect.orDie)
          const hooks = yield* PluginHooks.Service
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const pause = Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          })
          yield* hooks.register("permission", "evaluate", (event) =>
            Effect.gen(function* () {
              if (pass === "target") yield* pause
              event.effect = "allow"
            }),
          )
          yield* hooks.registerSourceReviewer((event) =>
            Effect.gen(function* () {
              if (pass === "source" && event.agent === "test") yield* pause
              event.effect = "allow"
            }),
          )
          const service = yield* Permission.Service
          const pending = yield* service.ask(assertion({ action: "read" })).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const values = {
            title: "bookkeeping",
            cost: 1,
            tokens_input: 2,
            tokens_output: 3,
            tokens_reasoning: 4,
            tokens_cache_read: 5,
            tokens_cache_write: 6,
            time_updated: 7,
            time_viewed: 8,
            time_idle: 9,
            idle_outcome: "succeeded" as const,
            metadata: { note: "non-authoritative" },
          }
          const change =
            field === "combined"
              ? values
              : field === "tokens"
                ? {
                    tokens_input: 2,
                    tokens_output: 3,
                    tokens_reasoning: 4,
                    tokens_cache_read: 5,
                    tokens_cache_write: 6,
                  }
                : field === "updated"
                  ? { time_updated: 7 }
                  : field === "viewed"
                    ? { time_viewed: 8 }
                    : field === "idle"
                      ? { time_idle: 9 }
                      : field === "outcome"
                        ? { idle_outcome: "succeeded" as const }
                        : field === "metadata"
                          ? { metadata: values.metadata }
                          : field === "cost"
                            ? { cost: 1 }
                            : { title: values.title }
          for (const id of [creator, Session.ID.make("ses_test")])
            yield* db.update(SessionTable).set(change).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(pending)).effect).toBe("allow")
          expect(yield* service.list()).toHaveLength(0)
        }),
      )
    }
  }
  for (const change of ["tighten", "target-tighten", "close", "move", "target-move", "agent", "dispose"] as const) {
    ceilingIt.effect(`awaited authenticated review cannot outrun ${change}`, () =>
      Effect.gen(function* () {
        const { db, creator } = yield* delegated
        yield* db
          .update(SessionTable)
          .set({ permission: [{ action: "read", resource: "*", effect: "ask" }] })
          .where(eq(SessionTable.id, creator))
          .run()
          .pipe(Effect.orDie)
        const hooks = yield* PluginHooks.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const registration = yield* hooks.registerSourceReviewer((event) =>
          event.agent === "test"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                event.effect = "allow"
              })
            : Effect.void,
        )
        const service = yield* Permission.Service
        const pending = yield* service.ask(assertion({ action: "read" })).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        if (change === "dispose") yield* registration.dispose
        else if (change === "close")
          yield* db.update(NewSessionTable).set({ stage: "accepted" }).run().pipe(Effect.orDie)
        else if (change === "target-tighten" || change === "target-move")
          yield* db
            .update(SessionTable)
            .set(
              change === "target-move"
                ? { directory: "/unknown" }
                : { permission: [{ action: "read", resource: "*", effect: "deny" }] },
            )
            .where(eq(SessionTable.id, Session.ID.make("ses_test")))
            .run()
            .pipe(Effect.orDie)
        else
          yield* db
            .update(SessionTable)
            .set(
              change === "move"
                ? { directory: "/unknown" }
                : change === "agent"
                  ? { agent: Agent.ID.make("God") }
                  : { permission: [{ action: "read", resource: "*", effect: "deny" }] },
            )
            .where(eq(SessionTable.id, creator))
            .run()
            .pipe(Effect.orDie)
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(pending)).effect).toBe("deny")
        expect(yield* service.list()).toEqual([])
      }),
    )
  }
  for (const pass of ["target", "source"] as const) {
    for (const delivery of ["queue", "steer"] as const) {
      for (const timing of ["before", "during", "cancelled-during"] as const) {
        ceilingIt.effect(
          `root USER ${delivery} ${timing} ${pass} review permits automatic allow without promotion`,
          () =>
            Effect.gen(function* () {
              const { db, creator } = yield* delegated
              yield* db
                .update(SessionDelegation.Table)
                .set({ agent_rules: [{ action: "read", resource: "*", effect: "ask" }] })
                .run()
                .pipe(Effect.orDie)
              const inbox = yield* SessionInbox.make()
              const id = SessionMessage.ID.create()
              const admit = inbox.admit({
                id,
                sessionID: creator,
                item: { type: "user", payload: { text: "STOP" }, delivery },
              })
              if (timing === "before") yield* admit
              const hooks = yield* PluginHooks.Service
              const entered = yield* Deferred.make<void>()
              const release = yield* Deferred.make<void>()
              const pause = Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              })
              yield* hooks.register("permission", "evaluate", (event) =>
                Effect.gen(function* () {
                  if (pass === "target") yield* pause
                  event.effect = "allow"
                }),
              )
              yield* hooks.registerSourceReviewer((event) =>
                Effect.gen(function* () {
                  if (pass === "source" && event.agent === "test") yield* pause
                  event.effect = "allow"
                }),
              )
              const service = yield* Permission.Service
              const pending = yield* service.ask(assertion({ action: "read" })).pipe(Effect.forkScoped)
              yield* Deferred.await(entered)
              if (timing !== "before") yield* admit
              const revision = yield* db
                .select()
                .from(KVTable)
                .where(eq(KVTable.key, SessionInbox.userAdmissionKey(creator)))
                .get()
                .pipe(Effect.orDie)
              expect(typeof revision?.value).toBe("number")
              // Retrying a matching inbox ID cannot alter payload, delivery or freshness.
              yield* inbox.admit({
                id,
                sessionID: creator,
                item: {
                  type: "user",
                  payload: { text: "different retry" },
                  delivery: delivery === "steer" ? "queue" : "steer",
                },
              })
              expect(
                (yield* db
                  .select()
                  .from(KVTable)
                  .where(eq(KVTable.key, SessionInbox.userAdmissionKey(creator)))
                  .get()
                  .pipe(Effect.orDie))?.value,
              ).toBe(revision?.value)
              if (timing === "cancelled-during") yield* inbox.cancel({ id, sessionID: creator })
              expect(
                yield* db
                  .select()
                  .from(SessionMessageTable)
                  .where(eq(SessionMessageTable.session_id, creator))
                  .all()
                  .pipe(Effect.orDie),
              ).toHaveLength(0)
              yield* Deferred.succeed(release, undefined)
              expect((yield* Fiber.join(pending)).effect).toBe("allow")
              expect(yield* service.list()).toEqual([])
            }),
        )
      }
    }
    for (const change of [
      "entry",
      "state",
      "revert",
      "root-parent",
      "root-missing",
      "saved",
      "hook-replace",
      "model",
      "target-agent",
    ] as const) {
      ceilingIt.effect(`${change} during ${pass} review preserves only non-input authority fences`, () =>
        Effect.gen(function* () {
          const { db, creator } = yield* delegated
          yield* db
            .update(SessionDelegation.Table)
            .set({ agent_rules: [{ action: "read", resource: "*", effect: "ask" }] })
            .run()
            .pipe(Effect.orDie)
          const hooks = yield* PluginHooks.Service
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const pause = Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          })
          yield* hooks.register("permission", "evaluate", (event) =>
            Effect.gen(function* () {
              if (pass === "target") yield* pause
              event.effect = "allow"
            }),
          )
          yield* hooks.registerSourceReviewer((event) =>
            Effect.gen(function* () {
              if (pass === "source" && event.agent === "test") yield* pause
              event.effect = "allow"
            }),
          )
          const service = yield* Permission.Service
          const pending = yield* service.ask(assertion({ action: "read" })).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          if (change === "entry")
            yield* db
              .insert(InstructionEntryTable)
              .values({ session_id: creator, key: "fixture", value: "new instruction" })
              .run()
              .pipe(Effect.orDie)
          if (change === "state")
            yield* db
              .insert(InstructionStateTable)
              .values({ session_id: creator, epoch_start: 1, through_seq: 2, initial_values: {}, current_values: {} })
              .run()
              .pipe(Effect.orDie)
          if (change === "revert")
            yield* db
              .update(SessionTable)
              .set({ revert: { messageID: SessionMessage.ID.make("msg_boundary") } })
              .where(eq(SessionTable.id, creator))
              .run()
              .pipe(Effect.orDie)
          if (change === "root-parent")
            yield* db
              .update(SessionTable)
              .set({ parent_id: Session.ID.make("ses_test") })
              .where(eq(SessionTable.id, creator))
              .run()
              .pipe(Effect.orDie)
          if (change === "root-missing")
            yield* db.delete(SessionTable).where(eq(SessionTable.id, creator)).run().pipe(Effect.orDie)
          if (change === "saved") {
            const saved = yield* PermissionSaved.Service
            yield* saved.add({ projectID: (yield* Location.Service).project.id, action: "read", resources: ["*"] })
          }
          if (change === "hook-replace") yield* hooks.register("permission", "evaluate", () => Effect.void)
          if (change === "model")
            yield* db
              .update(SessionTable)
              .set({ model: { providerID: "fake", id: "changed" } })
              .where(eq(SessionTable.id, Session.ID.make("ses_test")))
              .run()
              .pipe(Effect.orDie)
          if (change === "target-agent")
            yield* db
              .update(SessionTable)
              .set({ agent: Agent.ID.make("unknown") })
              .where(eq(SessionTable.id, Session.ID.make("ses_test")))
              .run()
              .pipe(Effect.orDie)
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(pending)).effect).toBe(
            change === "entry" || change === "state" || change === "revert" ? "allow" : "deny",
          )
          expect(yield* service.list()).toEqual([])
        }),
      )
    }
  }
  it.effect("ordinary primary review ignores bookkeeping and newly admitted USER", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask" }])
      const { db } = yield* Database.Service
      const hooks = yield* PluginHooks.Service
      const inbox = yield* SessionInbox.make()
      let admit = false
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.gen(function* () {
          yield* db
            .update(SessionTable)
            .set({ title: "changed", cost: 1, tokens_input: 1, metadata: { note: "not authority" } })
            .run()
            .pipe(Effect.orDie)
          if (admit)
            yield* inbox
              .admit({
                id: SessionMessage.ID.create(),
                sessionID: Session.ID.make("ses_test"),
                item: { type: "user", payload: { text: "STOP" }, delivery: "queue" },
              })
              .pipe(Effect.orDie)
          event.effect = "allow"
        }),
      )
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("allow")
      admit = true
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("allow")
      expect(yield* service.list()).toEqual([])
    }),
  )
  for (const pass of ["target", "source"] as const) {
    for (const change of [
      "source-hidden",
      "source-policy",
      "target-missing",
      "origin-missing",
      "directory-replaced",
      "workdir-replaced",
      "repository-missing",
      "inactive-receipt",
    ] as const) {
      ceilingIt.effect(`${change} during ${pass} review remains fenced`, () =>
        Effect.gen(function* () {
          const { db } = yield* delegated
          yield* db
            .update(SessionDelegation.Table)
            .set({ agent_rules: [{ action: "read", resource: "*", effect: "ask" }] })
            .run()
            .pipe(Effect.orDie)
          const directory = (yield* Location.Service).directory
          const git = promisify(execFile)
          const workdir = `${directory}-linked`
          if (change === "workdir-replaced") {
            yield* Effect.promise(() =>
              git("git", ["-C", directory, "worktree", "add", "--quiet", "--detach", workdir]),
            )
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await rm(workdir, { recursive: true, force: true })
                await rm(`${workdir}-old`, { recursive: true, force: true })
              }),
            )
            const info = yield* Effect.promise(() => stat(workdir))
            yield* db
              .update(NewSessionTable)
              .set({ workdir, directory_identity: `${info.dev}:${info.ino}` })
              .run()
              .pipe(Effect.orDie)
          }
          const hooks = yield* PluginHooks.Service
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let active = true
          const pause = Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          })
          yield* hooks.register("permission", "evaluate", (event) =>
            Effect.gen(function* () {
              if (pass === "target") yield* pause
              event.effect = "allow"
            }),
          )
          yield* hooks.registerSourceReviewer(
            (event) =>
              Effect.gen(function* () {
                if (pass === "source" && event.agent === "test") yield* pause
                event.effect = "allow"
              }),
            () => active,
          )
          const service = yield* Permission.Service
          const pending = yield* service.ask(assertion({ action: "read" })).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          if (change === "source-hidden") {
            const agents = yield* Agent.Service
            yield* agents.transform((editor) =>
              editor.update(Agent.ID.make("test"), (agent) => {
                agent.hidden = true
              }),
            )
          }
          if (change === "source-policy") yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
          if (change === "target-missing")
            yield* db
              .delete(SessionTable)
              .where(eq(SessionTable.id, Session.ID.make("ses_test")))
              .run()
              .pipe(Effect.orDie)
          if (change === "origin-missing") yield* db.delete(NewSessionTable).run().pipe(Effect.orDie)
          if (change === "inactive-receipt") active = false
          if (change === "directory-replaced" || change === "repository-missing") {
            const original = change === "directory-replaced" ? directory : `${directory}/.git`
            yield* Effect.promise(() => rename(original, `${original}-old`))
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await rm(original, { recursive: true, force: true })
                await rename(`${original}-old`, original)
              }),
            )
            if (change === "directory-replaced") yield* Effect.promise(() => mkdir(original))
          }
          if (change === "workdir-replaced")
            yield* Effect.promise(async () => {
              await rename(workdir, `${workdir}-old`)
              await mkdir(workdir)
            })
          yield* Deferred.succeed(release, undefined)
          const ordinaryAsk = change === "inactive-receipt" && pass === "target"
          expect((yield* Fiber.join(pending)).effect).toBe(ordinaryAsk ? "ask" : "deny")
          expect(yield* service.list()).toHaveLength(ordinaryAsk ? 1 : 0)
        }),
      )
    }
    for (const change of ["caller", "hook"] as const) {
      ceilingIt.effect(`${change} request mutation during ${pass} review cannot rebind permission`, () =>
        Effect.gen(function* () {
          const { db } = yield* delegated
          yield* db
            .update(SessionDelegation.Table)
            .set({ agent_rules: [{ action: "read", resource: "*", effect: "ask" }] })
            .run()
            .pipe(Effect.orDie)
          const hooks = yield* PluginHooks.Service
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const input = assertion({
            action: "read",
            resources: ["/original"],
            metadata: { marker: "original" },
            source: { type: "tool", messageID: SessionMessage.ID.make("msg_original"), id: "call_original" },
          })
          const pause = Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          })
          const mutate = (event: {
            action: string
            resources: readonly string[]
            metadata?: Record<string, unknown>
          }) => {
            event.action = "other"
            event.resources = ["/other"]
            event.metadata = { marker: "other" }
          }
          yield* hooks.register("permission", "evaluate", (event) =>
            Effect.gen(function* () {
              if (pass === "target") {
                yield* pause
                if (change === "hook") mutate(event)
              }
              event.effect = "allow"
            }),
          )
          yield* hooks.registerSourceReviewer((event) =>
            Effect.gen(function* () {
              if (pass === "source" && event.agent === "test") {
                yield* pause
                if (change === "hook") mutate(event)
              }
              if (event.agent === "test" && (change === "caller" || pass === "target")) {
                expect(event.action).toBe("read")
                expect(event.resources).toEqual(["/original"])
                expect(event.metadata).toEqual({ marker: "original" })
                expect(event.source).toEqual({ type: "tool", messageID: "msg_original", id: "call_original" })
              }
              event.effect = "allow"
            }),
          )
          const service = yield* Permission.Service
          const pending = yield* service.ask(input).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          input.action = "other"
          input.resources = ["/other"]
          input.metadata = { marker: "other" }
          input.source = { type: "tool", messageID: SessionMessage.ID.make("msg_other"), id: "call_other" }
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.join(pending)).effect).toBe(change === "caller" ? "allow" : "deny")
          expect(yield* service.list()).toEqual([])
        }),
      )
    }
  }
  ceilingIt.effect(
    "core review roots follow immutable creator provenance and fail closed for missing or cyclic lineage",
    () =>
      Effect.gen(function* () {
        const { db, creator } = yield* delegated
        expect(yield* SessionDelegation.reviewRoot(db, Session.ID.make("ses_test"))).toEqual({
          complete: true,
          sessionID: creator,
        })
        const child = Session.ID.make("ses_provenance_descendant")
        const placement = yield* Location.Service
        yield* db
          .insert(SessionTable)
          .values({
            id: child,
            project_id: placement.project.id,
            directory: placement.directory,
            parent_id: Session.ID.make("ses_fake_human"),
            slug: "descendant",
            version: "test",
            agent: Agent.ID.make("test"),
            metadata: { origin: "human", creator: "forged" },
          })
          .run()
          .pipe(Effect.orDie)
        yield* SessionDelegation.inherit(db, Session.ID.make("ses_test"), child)
        expect(yield* SessionDelegation.reviewRoot(db, child)).toEqual({ complete: true, sessionID: creator })
        const inbox = yield* SessionInbox.make()
        yield* inbox.admit({
          id: SessionMessage.ID.create(),
          sessionID: child,
          item: { type: "user", delivery: "queue", payload: { text: "agent-authored task brief" } },
        })
        const permissions = yield* Permission.Service
        expect((yield* permissions.ask(assertion({ sessionID: child, action: "read" }))).effect).toBe("allow")
        expect(yield* SessionDelegation.reviewRoot(db, Session.ID.make("ses_missing"))).toEqual({ complete: false })
        yield* db
          .update(SessionTable)
          .set({ parent_id: Session.ID.make("ses_test") })
          .where(eq(SessionTable.id, creator))
          .run()
          .pipe(Effect.orDie)
        expect(yield* SessionDelegation.reviewRoot(db, Session.ID.make("ses_test"))).toEqual({ complete: false })
      }),
  )
  ceilingIt.effect("pending approval cannot outrun current source tightening or closure", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      const service = yield* Permission.Service
      const bus = yield* Bus.Service
      const directory = (yield* Location.Service).directory
      for (const change of ["tighten", "move", "close"]) {
        yield* db
          .update(SessionTable)
          .set({ directory, permission: [{ action: "read", resource: "*", effect: "ask" }] })
          .where(eq(SessionTable.id, creator))
          .run()
          .pipe(Effect.orDie)
        const id = Permission.ID.create()
        const asked = yield* Deferred.make<void>()
        const stop = yield* bus.listen((event) =>
          event.type === Permission.Event.Asked.type
            ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
            : Effect.void,
        )
        const pending = yield* service.assert({ ...assertion({ action: "read" }), id }).pipe(Effect.forkScoped)
        yield* Deferred.await(asked)
        if (change === "close") yield* db.update(NewSessionTable).set({ stage: "accepted" }).run().pipe(Effect.orDie)
        else if (change === "move")
          yield* db
            .update(SessionTable)
            .set({ directory: "/unknown" })
            .where(eq(SessionTable.id, creator))
            .run()
            .pipe(Effect.orDie)
        else
          yield* db
            .update(SessionTable)
            .set({ permission: [{ action: "read", resource: "*", effect: "deny" }] })
            .where(eq(SessionTable.id, creator))
            .run()
            .pipe(Effect.orDie)
        yield* service.reply({ requestID: id, reply: "once" })
        const exit = yield* Fiber.await(pending)
        expect(exit._tag).toBe("Failure")
        yield* stop
      }
    }),
  )
  it.effect("new_session defaults to ask even beneath a generic allow rule", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "new_session" }))).effect).toBe("ask")
    }),
  )
  ceilingIt.effect("known source identity permits an action allowed by every ceiling layer", () =>
    Effect.gen(function* () {
      yield* delegated
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("allow")
    }),
  )
  ceilingIt.effect("a source deny survives target allow, saved grants and an allow hook", () =>
    Effect.gen(function* () {
      yield* delegated
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: ["*"] })
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          event.effect = "allow"
        }),
      )
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "shell" }))).effect).toBe("deny")
    }),
  )
  ceilingIt.effect("replacement session rules and forged metadata cannot erase provenance", () =>
    Effect.gen(function* () {
      const { db } = yield* delegated
      yield* db
        .update(SessionTable)
        .set({
          permission: [{ action: "*", resource: "*", effect: "allow" }],
          metadata: { origin: "human", creator: "forged" },
        })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "shell" }))).effect).toBe("deny")
      expect((yield* service.ask(assertion({ action: "new_session" }))).effect).toBe("deny")
    }),
  )
  ceilingIt.effect("creator movement fails closed instead of borrowing a different Location policy", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      yield* db
        .update(SessionTable)
        .set({ directory: "/elsewhere" })
        .where(eq(SessionTable.id, creator))
        .run()
        .pipe(Effect.orDie)
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("deny")
    }),
  )
  ceilingIt.effect("creator agent changes fail closed", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      yield* db.update(SessionTable).set({ agent: Agent.ID.make("God") }).where(eq(SessionTable.id, creator)).run().pipe(Effect.orDie)
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("deny")
    }),
  )
  ceilingIt.effect("current canonical source tightening intersects the original snapshot", () =>
    Effect.gen(function* () {
      yield* delegated
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("deny")
    }),
  )
  ceilingIt.effect("a source ask cannot be converted into allow by a target hook", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "ask" }] })
        .where(eq(SessionTable.id, creator))
        .run()
        .pipe(Effect.orDie)
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          event.effect = "allow"
        }),
      )
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ action: "read" }))).effect).toBe("ask")
    }),
  )
  ceilingIt.effect("explicit child provenance inheritance cannot be escaped by overriding permissions", () =>
    Effect.gen(function* () {
      const { db } = yield* delegated
      const child = Session.ID.make("ses_ceiling_child")
      yield* db
        .insert(SessionTable)
        .values({
          id: child,
          project_id: Project.ID.global,
          slug: "child",
          directory: "/project",
          version: "test",
          agent: Agent.ID.make("test"),
          permission: [{ action: "*", resource: "*", effect: "allow" }],
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionDelegation.inherit(db, Session.ID.make("ses_test"), child)
      const service = yield* Permission.Service
      expect((yield* service.ask(assertion({ sessionID: child, action: "shell" }))).effect).toBe("deny")
      expect((yield* service.ask(assertion({ sessionID: child, action: "new_session" }))).effect).toBe("deny")
    }),
  )
})

describe("manual model-review approval", () => {
  for (const parent of ["ses_missing_root", "ses_test"] as const) {
    it.effect(`incomplete root ${parent} cannot mint a manual override`, () => Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "ask" }])
      const { db } = yield* Database.Service
      yield* db.update(SessionTable).set({ parent_id: Session.ID.make(parent) }).where(eq(SessionTable.id, Session.ID.make("ses_test"))).run().pipe(Effect.orDie)
      expect((yield* SessionDelegation.authorityProof(db, Session.ID.make("ses_test"))).complete).toBe(false)
      yield* (yield* PluginHooks.Service).registerSourceReviewer((event) => Effect.sync(() => {
        event.effect = "deny"
        event.review = { kind: "model-refusal", reason: "Synthetic judgement" }
      }), () => true, true)
      const service = yield* Permission.Service
      let executions = 0
      const result = yield* service.assert({ sessionID: Session.ID.make("ses_test"), action: "read", resources: ["src/index.ts"], metadata: { action: { identity: "read", arguments: {}, cwd: "/project", complete: true } }, source: { type: "tool", id: "call_fixture", messageID: "msg_fixture" } }).pipe(Effect.tap(() => Effect.sync(() => { executions++ })), Effect.result)
      expect(result._tag).toBe("Failure")
      expect(executions).toBe(0)
      expect(yield* service.list()).toEqual([])
    }))
  }
  it.effect("complete pending root becoming incomplete cannot execute", () => Effect.gen(function* () {
    yield* setup([{ action: "*", resource: "*", effect: "ask" }])
    yield* (yield* PluginHooks.Service).registerSourceReviewer((event) => Effect.sync(() => { event.effect = "deny"; event.review = { kind: "model-refusal", reason: "Synthetic judgement" } }), () => true, true)
    let executions = 0
    const { service, fiber, request } = yield* waitForRequest({ metadata: { action: { identity: "read", arguments: {}, cwd: "/project", complete: true } }, source: { type: "tool", id: "call_fixture", messageID: "msg_fixture" } }, () => Effect.sync(() => { executions++ }))
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ parent_id: Session.ID.make("ses_missing_root") }).where(eq(SessionTable.id, Session.ID.make("ses_test"))).run().pipe(Effect.orDie)
    expect((yield* SessionDelegation.authorityProof(db, Session.ID.make("ses_test"))).complete).toBe(false)
    yield* service.reply({ requestID: request.id, reply: "review_once" }, true)
    expect((yield* Fiber.join(fiber).pipe(Effect.exit))._tag).toBe("Failure")
    expect(executions).toBe(0)
  }))
  it.effect("requires a native review_once and resumes exactly the original assertion", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "ask" }])
      const hooks = yield* PluginHooks.Service
      let reviews = 0
      let executions = 0
      yield* hooks.registerSourceReviewer((event) => Effect.sync(() => {
        reviews++
        event.effect = "deny"
        event.review = { kind: "model-refusal", reason: "Synthetic eligible judgement" }
      }), () => true, true)
      const { service, fiber, request } = yield* waitForRequest({
        metadata: { action: { identity: "read", arguments: { path: "src/index.ts" }, cwd: "/project", complete: true } },
        source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" },
      }, () => Effect.sync(() => { executions++ }))
      expect(request.review?.kind).toBe("model-refusal")
      expect(executions).toBe(0)
      for (const reply of ["once", "always"] as const) {
        const result = yield* service.reply({ requestID: request.id, reply }, true).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        expect(yield* service.get(request.id)).toBeDefined()
      }
      expect((yield* service.reply({ requestID: request.id, reply: "review_once" }).pipe(Effect.result))._tag).toBe("Failure")
      yield* service.reply({ requestID: request.id, reply: "review_once" }, true)
      yield* Fiber.join(fiber)
      expect(executions).toBe(1)
      expect(reviews).toBe(1)
      expect((yield* service.reply({ requestID: request.id, reply: "review_once" }, true).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* service.list()).toEqual([])
    }),
  )
  for (const kind of ["copied", "bash", "hard-hook", "missing-body", "name-only", "configured-deny"] as const) {
    it.effect(`does not create an override for ${kind}`, () => Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: kind === "configured-deny" ? "deny" : "ask" }])
      const hooks = yield* PluginHooks.Service
      const callback = (event: PermissionEvaluation) => Effect.sync(() => {
        event.effect = "deny"
        event.review = { kind: "model-refusal", reason: "Synthetic marker" }
      })
      if (kind === "copied") yield* hooks.register("permission", "evaluate", callback)
      else yield* hooks.registerSourceReviewer(callback, () => true, kind !== "bash")
      if (kind === "hard-hook") {
        yield* hooks.register("permission", "evaluate", (event) => Effect.sync(() => { event.effect = "deny" }))
        yield* hooks.register("permission", "evaluate", (event) => Effect.sync(() => { event.effect = "allow" }))
      }
      const service = yield* Permission.Service
      const result = yield* service.assert(assertion({
        metadata: kind === "missing-body" ? {} : { action: { identity: "read", complete: true, cwd: "/project", ...(kind === "name-only" ? {} : { arguments: { path: "src/index.ts" } }) } },
        source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" },
      })).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(yield* service.list()).toEqual([])
    }))
  }
  for (const change of ["revision", "policy", "disposal"] as const) {
    it.effect(`invalidates a pending approval after ${change}`, () => Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "ask" }])
      const hooks = yield* PluginHooks.Service
      const registration = yield* hooks.registerSourceReviewer((event) => Effect.sync(() => {
        event.effect = "deny"
        event.review = { kind: "model-refusal", reason: "Synthetic marker" }
      }), () => true, true)
      const { service, fiber, request } = yield* waitForRequest({
        metadata: { action: { identity: "read", complete: true, cwd: "/project", arguments: { path: "src/index.ts" } } },
        source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" },
      })
      if (change === "revision") yield* hooks.register("permission", "evaluate", () => Effect.void)
      if (change === "disposal") yield* registration.dispose
      if (change === "policy") yield* setRules([{ action: "*", resource: "*", effect: "deny" }])
      yield* service.reply({ requestID: request.id, reply: "review_once" }, true)
      expect((yield* Fiber.join(fiber).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* service.list()).toEqual([])
    }))
  }
})

describe("pending permission request expiry", () => {
  const reviewed = {
    metadata: { action: { identity: "read", arguments: { path: "src/index.ts" }, cwd: "/project", complete: true } },
    source: { type: "tool" as const, messageID: "msg_fixture", id: "call_fixture" },
  }
  // Every kind of request that parks a tool call until a human answers.
  const kinds = {
    "model-refusal": {
      input: reviewed,
      prepare: Effect.gen(function* () {
        yield* setup([{ action: "*", resource: "*", effect: "ask" }])
        yield* (yield* PluginHooks.Service).registerSourceReviewer((event) => Effect.sync(() => {
          event.effect = "deny"
          event.review = { kind: "model-refusal", reason: "Synthetic judgement" }
        }), () => true, true)
      }),
      approval: "review_once" as const,
      message: Permission.REVIEW_REQUEST_EXPIRED_MESSAGE,
    },
    "ordinary ask": {
      input: {},
      prepare: setup([{ action: "*", resource: "*", effect: "ask" }]),
      approval: "once" as const,
      message: Permission.PERMISSION_REQUEST_EXPIRED_MESSAGE,
    },
    "reviewer-failure ask": {
      input: reviewed,
      // A model reviewer that cannot decide leaves the human ask standing.
      prepare: Effect.gen(function* () {
        yield* setup([{ action: "*", resource: "*", effect: "ask" }])
        yield* (yield* PluginHooks.Service).registerSourceReviewer(() => Effect.void, () => true, true)
      }),
      approval: "once" as const,
      message: Permission.PERMISSION_REQUEST_EXPIRED_MESSAGE,
    },
  }
  const replies = Effect.gen(function* () {
    const seen: Array<{ sessionID: string; requestID: string; reply: string }> = []
    const unsubscribe = yield* (yield* Bus.Service).listen((event) => {
      if (event.type !== Permission.Event.Replied.type) return Effect.void
      const data = event.data as { sessionID: string; requestID: string; reply: string }
      seen.push({ sessionID: data.sessionID, requestID: data.requestID, reply: data.reply })
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })
  const corrected = (exit: unknown) => {
    const value = exit as { _tag: string; cause?: Cause.Cause<unknown> }
    if (value._tag !== "Failure" || !value.cause) return undefined
    const error = Cause.squash(value.cause)
    return error instanceof Permission.CorrectedError ? error.feedback : undefined
  }
  const answer = (service: Permission.Interface, requestID: Permission.ID, reply: "once" | "review_once" | "reject") =>
    service.reply({ requestID, reply }, reply === "review_once")

  it.effect("the messages are kind-appropriate and say what to do next", () =>
    Effect.sync(() => {
      expect(Duration.toMillis(Permission.PERMISSION_REQUEST_TIMEOUT)).toBe(120_000)
      expect(Permission.REVIEW_REQUEST_TIMEOUT).toBe(Permission.PERMISSION_REQUEST_TIMEOUT)
      for (const message of [Permission.REVIEW_REQUEST_EXPIRED_MESSAGE, Permission.PERMISSION_REQUEST_EXPIRED_MESSAGE]) {
        expect(message).toContain("did not answer")
        expect(message).toContain("within 2 minutes")
        expect(message).toMatch(/carry on with any other work/i)
        expect(message).toContain("exactly what you wanted to do and why")
        expect(message).toContain("retry the same call")
      }
      expect(Permission.REVIEW_REQUEST_EXPIRED_MESSAGE).toContain("permission reviewer referred this call")
      expect(Permission.PERMISSION_REQUEST_EXPIRED_MESSAGE).not.toContain("reviewer")
      expect(Permission.PERMISSION_REQUEST_EXPIRED_MESSAGE).toContain("retry the same call once")
    }),
  )

  for (const [kind, spec] of Object.entries(kinds)) {
    describe(kind, () => {
      it.effect("rejects an unanswered request after the timeout with model-facing guidance", () =>
        Effect.gen(function* () {
          yield* spec.prepare
          const seen = yield* replies
          let executions = 0
          const { service, fiber, request } = yield* waitForRequest(spec.input, () => Effect.sync(() => { executions++ }))
          expect(request.review?.kind).toBe(kind === "model-refusal" ? "model-refusal" : undefined)
          yield* TestClock.adjust(Duration.subtract(Permission.PERMISSION_REQUEST_TIMEOUT, Duration.millis(1)))
          expect(yield* service.get(request.id)).toBeDefined()
          expect(seen).toEqual([])
          yield* TestClock.adjust(Duration.millis(1))
          const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
          expect(corrected(exit)).toBe(spec.message)
          expect(executions).toBe(0)
          expect(seen).toEqual([{ sessionID: "ses_test", requestID: request.id, reply: "reject" }])
          expect(yield* service.list()).toEqual([])
        }),
      )

      it.effect("an answer before expiry runs once and cancels the timer", () =>
        Effect.gen(function* () {
          yield* spec.prepare
          const seen = yield* replies
          let executions = 0
          const { service, fiber, request } = yield* waitForRequest(spec.input, () => Effect.sync(() => { executions++ }))
          yield* TestClock.adjust(Duration.subtract(Permission.PERMISSION_REQUEST_TIMEOUT, Duration.seconds(1)))
          yield* answer(service, request.id, spec.approval)
          yield* Fiber.join(fiber)
          expect(executions).toBe(1)
          yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
          expect(seen.map((item) => item.reply)).toEqual([spec.approval])
          expect(executions).toBe(1)
          expect(yield* service.list()).toEqual([])
        }),
      )

      it.effect("a late approval after expiry fails cleanly without executing", () =>
        Effect.gen(function* () {
          yield* spec.prepare
          const seen = yield* replies
          let executions = 0
          const { service, fiber, request } = yield* waitForRequest(spec.input, () => Effect.sync(() => { executions++ }))
          yield* TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
          expect(corrected(yield* Fiber.join(fiber).pipe(Effect.exit))).toBe(spec.message)
          for (const reply of [spec.approval, "reject"] as const) {
            const late = yield* answer(service, request.id, reply).pipe(Effect.result)
            expect(late._tag).toBe("Failure")
            if (late._tag === "Failure") expect(late.failure).toBeInstanceOf(Permission.NotFoundError)
          }
          expect(executions).toBe(0)
          expect(seen.map((item) => item.reply)).toEqual(["reject"])
          expect(yield* service.list()).toEqual([])
        }),
      )

      // Each interleaving is forced from inside the winner's Replied publication, between its claim of the
      // pending entry and its resolution of the waiting assertion.
      for (const winner of ["answer", "expiry"] as const)
        it.effect(`an answer and expiry racing resolve exactly once (${winner} claims first)`, () =>
          Effect.gen(function* () {
            yield* spec.prepare
            const seen = yield* replies
            let executions = 0
            const { service, fiber, request } = yield* waitForRequest(spec.input, () => Effect.sync(() => { executions++ }))
            let loser: { _tag: string; failure?: unknown } | undefined
            const unsubscribe = yield* (yield* Bus.Service).listen((event) => {
              if (event.type !== Permission.Event.Replied.type || loser) return Effect.void
              loser = { _tag: "pending" }
              const lose: Effect.Effect<{ _tag: string; failure?: unknown }> = winner === "answer"
                ? TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT).pipe(Effect.as({ _tag: "Success" }))
                : answer(service, request.id, spec.approval).pipe(Effect.result)
              return lose.pipe(Effect.tap((result) => Effect.sync(() => { loser = result })), Effect.asVoid)
            })
            yield* Effect.addFinalizer(() => unsubscribe)
            if (winner === "answer") yield* answer(service, request.id, spec.approval)
            else yield* TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
            const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
            expect(loser?._tag).toBe(winner === "answer" ? "Success" : "Failure")
            expect(seen).toHaveLength(1)
            if (winner === "answer") {
              expect(exit._tag).toBe("Success")
              expect(executions).toBe(1)
              expect(seen[0]?.reply).toBe(spec.approval)
              yield* TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
              expect(seen).toHaveLength(1)
            } else {
              expect(loser?.failure).toBeInstanceOf(Permission.NotFoundError)
              expect(corrected(exit)).toBe(spec.message)
              expect(executions).toBe(0)
              expect(seen[0]?.reply).toBe("reject")
            }
            expect(yield* service.list()).toEqual([])
          }),
        )

      it.effect("an aborted wait leaves no timer behind", () =>
        Effect.gen(function* () {
          yield* spec.prepare
          const seen = yield* replies
          let executions = 0
          const { service, fiber, request } = yield* waitForRequest(spec.input, () => Effect.sync(() => { executions++ }))
          yield* Fiber.interrupt(fiber)
          expect(yield* service.get(request.id)).toBeUndefined()
          yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
          expect(seen).toEqual([])
          expect(executions).toBe(0)
          expect((yield* answer(service, request.id, spec.approval).pipe(Effect.result))._tag).toBe("Failure")
        }),
      )

      it.effect("shutdown declines the request and the timer does not fire afterwards", () =>
        Effect.gen(function* () {
          yield* spec.prepare
          const seen = yield* replies
          const { service, fiber } = yield* waitForRequest(spec.input)
          yield* service.close
          const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          expect(corrected(exit)).toBeUndefined()
          yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
          expect(seen.map((item) => item.reply)).toEqual(["reject"])
          expect(yield* service.list()).toEqual([])
        }),
      )
    })
  }

  it.effect("a reject of one request still settles its siblings once, before any expiry", () =>
    Effect.gen(function* () {
      yield* kinds["ordinary ask"].prepare
      const seen = yield* replies
      const first = yield* waitForRequest({ id: Permission.ID.create("per_first") })
      const second = yield* waitForRequest({ id: Permission.ID.create("per_second") })
      yield* first.service.reply({ requestID: first.request.id, reply: "reject" })
      expect((yield* Fiber.join(first.fiber).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* Fiber.join(second.fiber).pipe(Effect.exit))._tag).toBe("Failure")
      yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
      expect(seen.map((item) => [item.requestID, item.reply])).toEqual([
        [first.request.id, "reject"],
        [second.request.id, "reject"],
      ])
    }),
  )

  describe("externally created request (session.permission.create)", () => {
    it.effect("expires after the timeout and a late reply finds nothing", () =>
      Effect.gen(function* () {
        yield* kinds["ordinary ask"].prepare
        const seen = yield* replies
        const service = yield* Permission.Service
        const created = yield* service.ask(assertion())
        expect(created.effect).toBe("ask")
        yield* TestClock.adjust(Duration.subtract(Permission.PERMISSION_REQUEST_TIMEOUT, Duration.millis(1)))
        expect(yield* service.get(created.id)).toBeDefined()
        yield* TestClock.adjust(Duration.millis(1))
        expect(yield* service.get(created.id)).toBeUndefined()
        expect(seen).toEqual([{ sessionID: "ses_test", requestID: created.id, reply: "reject" }])
        const late = yield* service.reply({ requestID: created.id, reply: "once" }).pipe(Effect.result)
        expect(late._tag).toBe("Failure")
        if (late._tag === "Failure") expect(late.failure).toBeInstanceOf(Permission.NotFoundError)
      }),
    )
    it.effect("an answer stops its timer", () =>
      Effect.gen(function* () {
        yield* kinds["ordinary ask"].prepare
        const seen = yield* replies
        const service = yield* Permission.Service
        const created = yield* service.ask(assertion())
        yield* TestClock.adjust(Duration.seconds(30))
        yield* service.reply({ requestID: created.id, reply: "once" })
        yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
        expect(seen.map((item) => item.reply)).toEqual(["once"])
      }),
    )
    it.effect("shutdown settles it once and no timer fires afterwards", () =>
      Effect.gen(function* () {
        yield* kinds["ordinary ask"].prepare
        const seen = yield* replies
        const service = yield* Permission.Service
        yield* service.ask(assertion())
        yield* service.close
        yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
        expect(seen.map((item) => item.reply)).toEqual(["reject"])
      }),
    )
  })
})

describe("permission settlement ownership races (review regressions)", () => {
  it.effect("an interrupted external create must still acquire an expiry timer", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const asked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* (yield* Bus.Service).listen((event) =>
        event.type === Permission.Event.Asked.type ? Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)
      const creator = yield* service.ask(assertion()).pipe(Effect.forkScoped)
      yield* Deferred.await(asked)
      const interrupted = yield* Fiber.interrupt(creator).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupted)
      yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
      const pending = yield* service.list()
      expect(pending).toEqual([])
    }),
  )
  it.effect("expiry during an always cascade must not emit a later approval", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setup([], Session.ID.make("ses_other"))
      const selected = yield* waitForRequest({ save: ["src/*"] })
      const other = yield* waitForRequest({ id: Permission.ID.create("per_other"), sessionID: Session.ID.make("ses_other") })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const replies: string[] = []
      yield* (yield* Bus.Service).listen((event) => Effect.sync(() => {
        if (event.type === Permission.Event.Replied.type && (event.data as {requestID: string}).requestID === other.request.id)
          replies.push((event.data as {reply: string}).reply)
      }))
      yield* (yield* PluginHooks.Service).register("permission", "evaluate", (event) =>
        event.sessionID === other.request.sessionID ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)
      const approval = yield* selected.service.reply({ requestID: selected.request.id, reply: "always" }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
      const expired = yield* Fiber.join(other.fiber).pipe(Effect.exit)
      expect(expired._tag).toBe("Failure")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(approval)
      expect(replies).toEqual(["reject"])
    }),
  )
  it.effect("sibling rejection must claim the sibling before publishing", () =>
    Effect.gen(function* () {
      yield* setup()
      const first = yield* waitForRequest({ id: Permission.ID.create("per_first") })
      const second = yield* waitForRequest({ id: Permission.ID.create("per_second") })
      const replies: string[] = []
      let adjusted = false
      yield* (yield* Bus.Service).listen((event) => {
        if (event.type !== Permission.Event.Replied.type || (event.data as {requestID: string}).requestID !== second.request.id) return Effect.void
        replies.push((event.data as {reply: string}).reply)
        if (adjusted) return Effect.void
        adjusted = true
        return TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
      })
      yield* first.service.reply({ requestID: first.request.id, reply: "reject" })
      yield* Fiber.join(first.fiber).pipe(Effect.exit)
      yield* Fiber.join(second.fiber).pipe(Effect.exit)
      expect(replies).toEqual(["reject"])
    }),
  )
  it.effect("an always cascade must not execute after expiry has claimed the request", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setup([], Session.ID.make("ses_other"))
      const selected = yield* waitForRequest({ save: ["src/*"] })
      let executions = 0
      const other = yield* waitForRequest({ id: Permission.ID.create("per_other"), sessionID: Session.ID.make("ses_other") }, () => Effect.sync(() => { executions++ }))
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* (yield* PluginHooks.Service).register("permission", "evaluate", (event) =>
        event.sessionID === other.request.sessionID ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)
      const approval = yield* selected.service.reply({ requestID: selected.request.id, reply: "always" }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const replies: string[] = []
      yield* (yield* Bus.Service).listen((event) => {
        if (event.type !== Permission.Event.Replied.type || (event.data as {requestID: string}).requestID !== other.request.id) return Effect.void
        const reply = (event.data as {reply: string}).reply
        replies.push(reply)
        return reply === "reject" ? Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(approval)), Effect.ignore) : Effect.void
      })
      yield* TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
      yield* Fiber.join(other.fiber).pipe(Effect.exit)
      expect(executions).toBe(0)
      expect(replies).toEqual(["reject"])
    }),
  )
  it.effect("an interrupted external create before its announcement still expires once", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const replies: string[] = []
      yield* (yield* Bus.Service).listen((event) => Effect.sync(() => {
        if (event.type === Permission.Event.Replied.type) replies.push((event.data as { reply: string }).reply)
      }))
      const creator = yield* service.ask(assertion()).pipe(Effect.forkScoped)
      yield* Fiber.interrupt(creator)
      const created = yield* service.list()
      yield* TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
      expect(yield* service.list()).toEqual([])
      expect(replies).toEqual(created.length ? ["reject"] : [])
    }),
  )
  it.effect("an always cascade still approves a matching request that is still pending", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "ask" }])
      const selected = yield* waitForRequest({ save: ["src/*"], resources: ["src/a.ts"] })
      let executions = 0
      const other = yield* waitForRequest({ id: Permission.ID.create("per_other"), resources: ["src/b.ts"] }, () => Effect.sync(() => { executions++ }))
      yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
      yield* Fiber.join(other.fiber)
      expect(executions).toBe(1)
      yield* TestClock.adjust(Duration.times(Permission.PERMISSION_REQUEST_TIMEOUT, 2))
      expect(yield* selected.service.list()).toEqual([])
    }),
  )
  it.effect("shutdown racing expiry settles each request once", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "ask" }])
      const first = yield* waitForRequest({ id: Permission.ID.create("per_first") })
      const second = yield* waitForRequest({ id: Permission.ID.create("per_second") })
      const replies: Array<[string, string]> = []
      let adjusted = false
      yield* (yield* Bus.Service).listen((event) => {
        if (event.type !== Permission.Event.Replied.type) return Effect.void
        const data = event.data as { requestID: string; reply: string }
        replies.push([data.requestID, data.reply])
        if (adjusted) return Effect.void
        adjusted = true
        return TestClock.adjust(Permission.PERMISSION_REQUEST_TIMEOUT)
      })
      yield* first.service.close
      yield* Fiber.join(first.fiber).pipe(Effect.exit)
      yield* Fiber.join(second.fiber).pipe(Effect.exit)
      expect(replies.map(([id]) => id).sort()).toEqual([first.request.id, second.request.id].sort())
      expect(replies.every(([, reply]) => reply === "reject")).toBe(true)
    }),
  )
})

describe("delegated source-review ask expiry", () => {
  ceilingIt.effect("a delegated source-review ask expires like any other request", () =>
    Effect.gen(function* () {
      const { db, creator } = yield* delegated
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "ask" }] })
        .where(eq(SessionTable.id, creator))
        .run()
        .pipe(Effect.orDie)
      const seen: string[] = []
      const unsubscribe = yield* (yield* Bus.Service).listen((event) => {
        if (event.type === Permission.Event.Replied.type) seen.push((event.data as { reply: string }).reply)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      let executions = 0
      const { service, fiber, request } = yield* waitForRequest({}, () => Effect.sync(() => { executions++ }))
      yield* TestClock.adjust(Duration.subtract(Permission.PERMISSION_REQUEST_TIMEOUT, Duration.millis(1)))
      expect(yield* service.get(request.id)).toBeDefined()
      yield* TestClock.adjust(Duration.millis(1))
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Permission.CorrectedError)
        if (error instanceof Permission.CorrectedError) expect(error.feedback).toBe(Permission.PERMISSION_REQUEST_EXPIRED_MESSAGE)
      }
      expect(executions).toBe(0)
      expect(seen).toEqual(["reject"])
      expect(yield* service.list()).toEqual([])
    }),
  )
})

function setup(rules: Permission.Ruleset = [], sessionID = Session.ID.make("ses_test")) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: Agent.ID.make("test"),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create("per_test"),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}

function waitForRequest(input: Partial<Permission.AssertInput> = {}, execute: () => Effect.Effect<void> = () => Effect.void) {
  return Effect.gen(function* () {
    const value = assertion(input)
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      return request.id === value.id ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.tap(execute), Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("Permission", () => {
  for (const parented of [false, true]) {
    for (const historical of [false, true]) {
      it.effect(
        `pending input permits assert without promotion (child=${parented}, historical=${historical})`,
        () =>
          Effect.gen(function* () {
            yield* setup([{ action: "read", resource: "*", effect: "allow" }])
            const { db } = yield* Database.Service
            const root = Session.ID.make("ses_test")
            const child = Session.ID.make("ses_stale_child")
            if (parented)
              yield* db
                .insert(SessionTable)
                .values({
                  id: child,
                  parent_id: root,
                  project_id: Project.ID.global,
                  directory: "/project",
                  slug: "child",
                  version: "test",
                  agent: Agent.ID.make("test"),
                })
                .run()
                .pipe(Effect.orDie)
            const inbox = yield* SessionInbox.make()
            yield* inbox.admit({
              id: SessionMessage.ID.create(),
              sessionID: root,
              item: { type: "user", delivery: "steer", payload: { text: "STOP" } },
            })
            if (historical)
              yield* db
                .delete(KVTable)
                .where(eq(KVTable.key, SessionInbox.userAdmissionKey(root)))
                .run()
                .pipe(Effect.orDie)
            const service = yield* Permission.Service
            const bus = yield* Bus.Service
            let asked = 0
            let effects = 0
            yield* bus.listen((event) =>
              Effect.sync(() => {
                if (event.type === Permission.Event.Asked.type) asked++
              }),
            )
            yield* service.assert(assertion({ sessionID: parented ? child : root })).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  effects++
                }),
              ),
            )
            expect(asked).toBe(0)
            expect(effects).toBe(1)
            expect(yield* service.list()).toEqual([])
            expect(yield* inbox.list(root)).toHaveLength(1)
            yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
            expect(
              yield* service.assert(assertion({ sessionID: parented ? child : root })).pipe(Effect.flip),
            ).toBeInstanceOf(Permission.BlockedError)
          }),
      )
    }
  }
  for (const reply of ["once", "always"] as const) {
    it.effect(`an existing genuine ask retains ${reply} approval despite new input`, () =>
      Effect.gen(function* () {
        yield* setup()
        const selected = yield* waitForRequest({ save: ["src/*"] })
        const inbox = yield* SessionInbox.make()
        yield* inbox.admit({
          id: SessionMessage.ID.create(),
          sessionID: selected.request.sessionID,
          item: { type: "user", delivery: "steer", payload: { text: "STOP" } },
        })
        yield* selected.service.reply({ requestID: selected.request.id, reply })
        const exit = yield* Fiber.await(selected.fiber)
        expect(exit._tag).toBe("Success")
        expect(yield* selected.service.list()).toEqual([])
      }),
    )
  }
  it.effect("bulk always approves matching siblings despite pending input", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setup([], Session.ID.make("ses_other"))
      const selected = yield* waitForRequest({ save: ["src/*"] })
      const other = yield* waitForRequest({ id: Permission.ID.create(), sessionID: Session.ID.make("ses_other") })
      const bus = yield* Bus.Service
      const replies: string[] = []
      yield* bus.listen((event) =>
        Effect.sync(() => {
          if (event.type !== Permission.Event.Replied.type) return
          const reply = event.data as { requestID: string; reply: string }
          if (reply.requestID === other.request.id) replies.push(reply.reply)
        }),
      )
      const inbox = yield* SessionInbox.make()
      yield* inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID: other.request.sessionID,
        item: { type: "user", delivery: "queue", payload: { text: "STOP" } },
      })
      yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
      yield* Fiber.join(selected.fiber)
      const exit = yield* Fiber.await(other.fiber)
      expect(exit._tag).toBe("Success")
      expect(replies).toEqual(["always"])
      expect(yield* selected.service.list()).toEqual([])
    }),
  )
  it.effect("actual Code Mode allSettled permits allowed operations despite pending input", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const inbox = yield* SessionInbox.make()
      yield* inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID: Session.ID.make("ses_test"),
        item: { type: "user", delivery: "steer", payload: { text: "STOP" } },
      })
      let protectedEffects = 0
      let siblingEffects = 0
      const codeMode = CodeModeTool.create(
        {
          tools: new Map([
            [
              "guarded",
              {
                name: "guarded",
                description: "Guarded fixture",
                input: Schema.Struct({}),
                execute: () =>
                  service.assert(assertion()).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        protectedEffects++
                        return { content: "Executed" }
                      }),
                    ),
                    Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
                  ),
              },
            ],
            [
              "sibling",
              {
                name: "sibling",
                description: "Independent fixture",
                input: Schema.Struct({}),
                execute: () =>
                  Effect.sync(() => {
                    siblingEffects++
                    return { content: "completed once" }
                  }),
              },
            ],
          ]),
        },
        (_, tool, input, context) => execute(tool, input, context),
        service,
      )
      const result = yield* codeMode.execute(
        { code: "return await Promise.allSettled([tools.guarded({}), tools.sibling({})])" },
        {
          sessionID: Session.ID.make("ses_test"),
          agent: Agent.ID.make("test"),
          messageID: SessionMessage.ID.create(),
          id: Tool.CallID.make("call_stale"),
          progress: () => Effect.void,
        },
      )
      expect(JSON.stringify(result.content)).toContain("Executed")
      expect(JSON.stringify(result.content)).toContain("completed once")
      expect(protectedEffects).toBe(1)
      expect(siblingEffects).toBe(1)
      expect(yield* service.list()).toEqual([])
    }),
  )
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: Agent.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("explains a configured deny with the deciding rule and its layer", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "subagent", resource: "John", effect: "allow" },
      ])
      const service = yield* Permission.Service
      yield* service.assert(assertion({ action: "subagent", resources: ["John"] }))
      const blocked = yield* service.assert(assertion({ action: "subagent", resources: ["Kryten"] })).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(blocked).toMatchObject({ explanation: "agent test: subagent * deny for Kryten" })
      expect(blocked.message).toBe("Permission denied: subagent (agent test: subagent * deny for Kryten)")

      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "subagent", resource: "John", effect: "deny" }] })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const session = yield* service.assert(assertion({ action: "subagent", resources: ["John"] })).pipe(Effect.flip)
      expect(session).toMatchObject({ explanation: "session: subagent John deny for John" })
    }),
  )

  it.effect("explains the deny-all used when the agent cannot be found", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const blocked = yield* service
        .assert(assertion({ agent: Agent.ID.make("Kryten"), resources: ["*"] }))
        .pipe(Effect.flip)
      expect(blocked).toMatchObject({
        explanation: "missing agent Kryten could not be found, so everything is refused",
      })
    }),
  )

  it.effect("lets plugins observe configured denies without overturning them", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "deny" }])
      const hooks = yield* PluginHooks.Service
      const seen: Array<{ effect: string; refusal?: string }> = []
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          seen.push({ effect: event.effect, refusal: event.refusal })
          event.effect = "allow"
        }),
      )
      const service = yield* Permission.Service
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(seen).toEqual([{ effect: "deny", refusal: "agent test: read * deny for src/index.ts" }])
    }),
  )

  it.effect("explains a deny set by a plugin hook and keeps the hook's message", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "ask" }])
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          expect(event.refusal).toBeUndefined()
          event.effect = "deny"
          event.message = "Reviewer refused: outside the project"
        }),
      )
      const service = yield* Permission.Service
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked.message).toBe("Reviewer refused: outside the project")
      expect(blocked).toMatchObject({
        explanation: "refused by a permission plugin: Reviewer refused: outside the project",
      })
    }),
  )
  it.effect("checks for a deny without asking", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      yield* service.assertNotDenied(assertion())
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.assertNotDenied(assertion()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
    }),
  )

  it.effect("reports whether a request is already allowed without asking", () =>
    Effect.gen(function* () {
      yield* setup([])
      const service = yield* Permission.Service
      expect(yield* service.allows(assertion())).toBe(false)
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "allow" }])
      expect(yield* service.allows(assertion())).toBe(true)
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.allows(assertion())).toBe(false)
    }),
  )

  test("matches Windows rule resources against slash-normalized file access resources", () => {
    const rules: Permission.Ruleset = [
      { action: "external_directory", resource: "C:\\Users\\x\\proj\\*", effect: "allow" },
    ]
    expect(Permission.evaluate("external_directory", "C:/Users/x/proj/src/*", rules).effect).toBe("allow")
    expect(Permission.evaluate("external_directory", "C:/Users/x/other/*", rules).effect).toBe("ask")
  })

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* Permission.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "custom", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "custom", resources: ["*"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => {
        editor.remove(Agent.ID.make("test"))
        editor.remove(Agent.ID.make("build"))
      })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion())).toEqual({ id: Permission.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: Permission.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(Permission.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("merges session rules after agent rules and before saved approvals", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const { db } = yield* Database.Service
      const service = yield* Permission.Service
      const setSession = (permission: Permission.Ruleset) =>
        db
          .update(SessionTable)
          .set({ permission })
          .where(eq(SessionTable.id, Session.ID.make("ses_test")))
          .run()
          .pipe(Effect.orDie)

      yield* setSession([{ action: "edit", resource: "/original/**", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "edit", resources: ["/original/src/index.ts"] }))).toMatchObject({
        effect: "deny",
      })

      yield* setRules([])
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })
      yield* setSession([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "deny" })
      yield* setSession([{ action: "bash", resource: "*", effect: "ask" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* Permission.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: Permission.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(Session.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("drops undefined metadata values so pending requests encode as JSON", () =>
    Effect.gen(function* () {
      yield* setup()
      // Tools copy optional model inputs straight into metadata, so omitted inputs arrive as undefined values.
      const { service, request } = yield* waitForRequest({
        action: "glob",
        resources: ["/project"],
        metadata: { root: "/project", path: undefined, hidden: undefined, limit: undefined },
      })
      expect(request.metadata).toStrictEqual({ root: "/project" })
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      // HttpApi encodes JSON success bodies through Schema.toCodecJson, which rejects undefined values in Unknown.
      const encode = Schema.encodeEffect(Schema.toCodecJson(Schema.Struct({ data: Schema.Array(Permission.Request) })))
      expect(yield* encode({ data: yield* service.forSession(request.sessionID) })).toEqual({
        data: [
          {
            id: request.id,
            sessionID: request.sessionID,
            action: "glob",
            resources: ["/project"],
            metadata: { root: "/project" },
          },
        ],
      })
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* Permission.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Asked.type
          ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toMatchObject([
        { id, projectID: Project.ID.global, action: "read", resource: "src/*" },
      ])
      yield* service.assert(assertion({ id: Permission.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("edits saved approvals and enforces the edited rule", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      const service = yield* Permission.Service
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["src/*", "docs/*"] })
      const src = (yield* saved.list()).find((item) => item.resource === "src/*")

      expect(yield* saved.update({ id: src!.id, resource: "src/allowed.ts" })).toMatchObject({
        id: src!.id,
        projectID: Project.ID.global,
        action: "read",
        resource: "src/allowed.ts",
      })
      expect(
        yield* service.ask(assertion({ id: Permission.ID.create("per_allowed"), resources: ["src/allowed.ts"] })),
      ).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ id: Permission.ID.create("per_other"), resources: ["src/other.ts"] })),
      ).toMatchObject({ effect: "ask" })

      expect(yield* saved.update({ id: src!.id, resource: "docs/*" }).pipe(Effect.flip)).toMatchObject({
        _tag: "PermissionSaved.ConflictError",
        id: src!.id,
        resource: "docs/*",
      })
      expect(
        yield* saved.update({ id: PermissionSaved.ID.make("psv_missing"), action: "edit" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "PermissionSaved.NotFoundError" })
    }),
  )

  for (const guard of ["configured deny", "missing Session"] as const) {
    it.effect(`skips pending auto-approval after always for ${guard}`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setup([], Session.ID.make("ses_other"))
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(Agent.ID.make("reviewer"), (agent) => {
            agent.permissions = []
          }),
        )
        const selected = yield* waitForRequest({ save: ["src/*"] })
        const other = yield* waitForRequest({
          id: Permission.ID.create("per_other"),
          sessionID: Session.ID.make("ses_other"),
          agent: Agent.ID.make("reviewer"),
        })
        if (guard === "configured deny") {
          yield* agents.transform((editor) =>
            editor.update(Agent.ID.make("reviewer"), (agent) => {
              agent.permissions = [{ action: "read", resource: "*", effect: "deny" }]
            }),
          )
        }
        if (guard === "missing Session") {
          const { db } = yield* Database.Service
          yield* db.delete(SessionTable).where(eq(SessionTable.id, other.request.sessionID)).run().pipe(Effect.orDie)
        }
        yield* selected.service.reply({ requestID: selected.request.id, reply: "always" })
        yield* Fiber.join(selected.fiber)
        expect(yield* selected.service.list()).toEqual([other.request])
        expect(other.fiber.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(other.fiber)
        expect(yield* selected.service.list()).toEqual([])
      }),
    )
  }
})

describe("shell scanner permission impact", () => {
  // Fixed cases require matching outcomes; remaining differences are investigation snapshots, not contracts.
  // These service-level cases all have command resources; tool tests cover skipped checks and directories.
  // Outcome pairs are [legacy, native].
  for (const fixture of [
    {
      name: "timed command preserves wrapper approvals",
      shell: "bash",
      command: "time -p git status",
      approved: ["time *"],
      exact: ["time -p git status"],
      denied: "time -p git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "coprocess command preserves wrapper approvals",
      shell: "bash",
      command: "coproc git status",
      approved: ["coproc *"],
      exact: ["coproc git status"],
      denied: "coproc git status",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "declarations and unset",
      shell: "bash",
      command: "export X=value; unset X; git status",
      approved: ["git status *"],
      exact: ["git status"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export with an approved command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "export *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "export retains checks on the command substitution",
      shell: "bash",
      command: "export VERSION=$(git describe --tags); npm run build",
      approved: ["git describe *", "npm run build *"],
      exact: ["git describe --tags", "npm run build"],
      denied: "git describe *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a conditional list",
      shell: "bash",
      command: "printf ok && git status > output",
      approved: ["printf *", "git status *"],
      exact: ["printf ok", "git status"],
      denied: "git status *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "redirect after a pipeline",
      shell: "bash",
      command: "printf ok | cat < input > output",
      approved: ["printf *", "cat *"],
      exact: ["printf ok", "cat"],
      denied: "cat *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect followed by a command",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      approved: ["printf *"],
      exact: ["printf done"],
      denied: "FOO=bar > output",
      savedEffect: ["ask", "ask"],
      exactEffect: ["ask", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "assignment redirect with an approved command substitution",
      shell: "bash",
      command: "VERSION=$(git describe --tags) > build/version.txt",
      approved: ["git describe *"],
      exact: ["git describe --tags"],
      denied: "VERSION=$(git describe --tags) > build/version.txt",
      savedEffect: ["ask", "ask"],
      exactEffect: ["ask", "ask"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "substitution in a saved prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      approved: ["git *", "printf *"],
      exact: ["git $(printf diff) --stat", "printf diff"],
      denied: "git $(printf diff) --stat",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "standalone PowerShell scriptblock caller",
      shell: "pwsh",
      command: "ForEach-Object { Write-Output value }",
      approved: ["Write-Output *"],
      exact: ["Write-Output value"],
      denied: "ForEach-Object *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["allow", "allow"],
    },
    {
      name: "tab-separated PowerShell command",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      approved: ["git status *", "Write-Output *"],
      exact: ["git status", "Write-Output done"],
      denied: "git\tstatus",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "PowerShell equals-joined argument",
      shell: "pwsh",
      command: "git --work-tree=src status",
      approved: ["git --work-tree *"],
      exact: ["git --work-tree"],
      denied: "git --work-tree",
      savedEffect: ["allow", "ask"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["deny", "allow"],
    },
    {
      name: "trailing redirect after list operator",
      shell: "bash",
      command: "true && cat > secret",
      approved: ["true *", "cat *"],
      exact: ["true", "cat"],
      denied: "* > secret*",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "ask"],
      deniedEffect: ["allow", "deny"],
    },
    {
      name: "commandless redirect write",
      shell: "zsh",
      command: ">> ~/.zshrc <<< 'x'",
      approved: [">> *"],
      exact: [">> ~/.zshrc <<< 'x'"],
      denied: ">> *",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
    {
      name: "PowerShell .NET method invocation",
      shell: "pwsh",
      command: '[IO.File]::Delete("C:\\victim")',
      approved: ["[IO.File]::Delete(*"],
      exact: ['[IO.File]::Delete("C:\\victim")'],
      denied: "*Delete(*",
      savedEffect: ["allow", "allow"],
      exactEffect: ["allow", "allow"],
      deniedEffect: ["deny", "deny"],
    },
  ] as const) {
    for (const scenario of [
      { name: "no approval", saved: [], rules: [], expected: ["ask", "ask"] },
      { name: "saved wildcard", saved: ["*"], rules: [], expected: ["allow", "allow"] },
      { name: "saved command approvals", saved: fixture.approved, rules: [], expected: fixture.savedEffect },
      {
        name: "exact configured approvals",
        saved: [],
        rules: fixture.exact.map((resource): Permission.Rule => ({ action: "shell", resource, effect: "allow" })),
        expected: fixture.exactEffect,
      },
      {
        name: "exact saved approvals",
        saved: fixture.exact,
        rules: [],
        expected: fixture.exactEffect,
      },
      {
        name: "configured deny despite saved wildcard",
        saved: ["*"],
        rules: [{ action: "shell", resource: fixture.denied, effect: "deny" }] satisfies Permission.Ruleset,
        expected: fixture.deniedEffect,
      },
    ] as const) {
      it.live(`${fixture.name}: ${scenario.name}`, () =>
        Effect.gen(function* () {
          yield* setup(scenario.rules)
          const saved = yield* PermissionSaved.Service
          yield* saved.add({ projectID: Project.ID.global, action: "shell", resources: scenario.saved })
          const service = yield* Permission.Service

          const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project")
          expect(parsed.commands.length).toBeGreaterThan(0)
          expect(parsed.directories).toEqual([])
          const result = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(result.effect).toBe(scenario.expected[1])
          const pending = yield* service.list()
          expect(pending).toHaveLength(result.effect === "ask" ? 1 : 0)
          if (result.effect === "ask") {
            expect(pending[0]?.resources).toEqual(parsed.commands.map((command) => command.resource))
            expect(pending[0]?.save).toEqual(parsed.commands.map((command) => command.save))
            yield* service.reply({ requestID: result.id, reply: "once" })
            expect(yield* service.list()).toEqual([])
          }
        }),
      )
    }
  }

  // Grant/repeat rows select the granting parser; repeat columns select the parser used afterwards.
  for (const fixture of [
    {
      name: "numeric npm script prefix",
      shell: "bash",
      command: "npm run 123",
      grants: [["npm run *"], ["npm run 123 *"]],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "npm run build",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "numeric AWS option prefix",
      shell: "bash",
      command: "aws --cli-read-timeout 60 s3 ls",
      grants: [["aws --cli-read-timeout s3 *"], ["aws --cli-read-timeout 60 *"]],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "aws --cli-read-timeout 60 ec2 describe-instances",
      nextEffect: ["ask", "allow"],
    },
    {
      name: "substitution prefix",
      shell: "bash",
      command: "git $(printf diff) --stat",
      grants: [
        ["git --stat *", "printf *"],
        ["git $(printf diff) *", "printf *"],
      ],
      repeat: [
        ["ask", "ask"],
        ["allow", "allow"],
      ],
      next: "git --stat",
      nextEffect: ["allow", "ask"],
    },
    {
      name: "redirect prefix",
      shell: "bash",
      command: "printf ok && git status > output",
      grants: [
        ["printf *", "git status *"],
        ["printf *", "git status *"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: "git status --short",
      nextEffect: ["allow", "allow"],
    },
    {
      name: "assignment redirect prefix",
      shell: "bash",
      command: "FOO=bar > output; printf done",
      grants: [
        ["printf *"],
        ["FOO=bar > *", "printf *"],
      ],
      repeat: [
        ["ask", "allow"],
        ["ask", "allow"],
      ],
      next: "FOO=bar rm -rf /",
      nextEffect: ["ask", "ask"],
    },
    {
      name: "PowerShell method prefix",
      shell: "pwsh",
      command: '[IO.File]::Delete("C:\\first")',
      grants: [
        ["[IO.File]::Delete(*"],
        ["[IO.File]::Delete(*"],
      ],
      repeat: [
        ["allow", "allow"],
        ["allow", "allow"],
      ],
      next: '[IO.File]::WriteAllText("C:\\first", "x")',
      nextEffect: ["ask", "ask"],
    },
    {
      name: "PowerShell tab prefix",
      shell: "pwsh",
      command: "git\tstatus; Write-Output done",
      grants: [["Write-Output *"], ["git\tstatus *", "Write-Output *"]],
      repeat: [
        ["allow", "ask"],
        ["allow", "allow"],
      ],
      next: "git status",
      nextEffect: ["ask", "ask"],
    },
  ] as const) {
    it.live(`${fixture.name}: always allow covers repeat execution and narrows prefix scope`, () =>
      Effect.gen(function* () {
        yield* setup()
        const service = yield* Permission.Service
        const saved = yield* PermissionSaved.Service
        const parsed = yield* ShellParse.scan(fixture.command, fixture.shell, "/project")
        const first = yield* service.ask(
          assertion({
            action: "shell",
            resources: parsed.commands.map((command) => command.resource),
            save: parsed.commands.map((command) => command.save),
          }),
        )
        expect(first.effect).toBe("ask")
        expect(yield* service.list()).toHaveLength(1)
        yield* service.reply({ requestID: first.id, reply: "always" })
        expect(yield* service.list()).toEqual([])
        expect((yield* saved.list({ projectID: Project.ID.global })).map((rule) => rule.resource).sort()).toEqual(
          [...fixture.grants[1]].sort(),
        )

        for (const command of [fixture.command, fixture.next]) {
          const parsed = yield* ShellParse.scan(command, fixture.shell, "/project")
          const result = yield* service.ask(
            assertion({
              action: "shell",
              resources: parsed.commands.map((command) => command.resource),
              save: parsed.commands.map((command) => command.save),
            }),
          )
          expect(result.effect, command).toBe(command === fixture.next ? fixture.nextEffect[1] : fixture.repeat[1]?.[1])
          if (result.effect === "ask") yield* service.reply({ requestID: result.id, reply: "once" })
          expect(yield* service.list()).toEqual([])
        }
      }),
    )
  }
})
