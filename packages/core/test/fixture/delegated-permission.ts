import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { SessionDelegation } from "@opencode/core/session/delegation"
import { NewSessionTable } from "@opencode/core/session/new-session.sql"
import { SessionMessage } from "@opencode/core/session/message"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { stat } from "node:fs/promises"

/** Real immutable native-owner ceiling in an isolated Git-backed Instance. */
export const delegated = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
    }),
  )
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: Session.ID.make("ses_test"),
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
  const location = yield* Location.Service
  const directory = location.directory
  const projectID = location.project.id
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
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

export function assertion(input: Partial<Permission.AssertInput> = {}) {
  return {
    id: Permission.ID.create(),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
}
