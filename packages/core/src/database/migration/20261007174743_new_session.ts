import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261007174743_new_session",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`new_session_launch\` (
          \`id\` text PRIMARY KEY,
          \`creator_id\` text NOT NULL,
          \`launch_key\` text NOT NULL,
          \`payload_hash\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`ownership_key\` text NOT NULL,
          \`canonical\` text NOT NULL,
          \`workdir\` text NOT NULL,
          \`directory_identity\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`prompt_id\` text NOT NULL,
          \`notification_id\` text NOT NULL,
          \`stage\` text NOT NULL,
          \`terminal\` text,
          \`notification_admitted\` integer DEFAULT false NOT NULL,
          \`evidence\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_delegation\` (
          \`session_id\` text PRIMARY KEY,
          \`origin_id\` text NOT NULL,
          \`creator_id\` text NOT NULL,
          \`source_agent\` text NOT NULL,
          \`source_directory\` text NOT NULL,
          \`agent_rules\` text NOT NULL,
          \`session_rules\` text NOT NULL,
          \`target_agent\` text NOT NULL,
          \`target_model\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`new_session_creator_key\` ON \`new_session_launch\` (\`creator_id\`,\`launch_key\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`new_session_owner\` ON \`new_session_launch\` (\`project_id\`,\`ownership_key\`) WHERE "new_session_launch"."stage" <> 'accepted';`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`new_session_workdir\` ON \`new_session_launch\` (\`workdir\`) WHERE "new_session_launch"."stage" <> 'accepted';`,
      )
    })
  },
}

export default migration
