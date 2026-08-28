import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828114216_permission_review_delegation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_review_delegation\` (
          \`child_turn_id\` text PRIMARY KEY,
          \`child_session_id\` text NOT NULL,
          \`parent_turn_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`root_turn_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`task_message_id\` text NOT NULL,
          \`task_part_id\` text NOT NULL,
          \`task_call_id\` text NOT NULL,
          \`child_agent\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_permission_review_delegation_child_turn_id_message_id_fk\` FOREIGN KEY (\`child_turn_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_delegation_child_session_id_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_delegation_parent_turn_id_message_id_fk\` FOREIGN KEY (\`parent_turn_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_delegation_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_delegation_root_turn_id_message_id_fk\` FOREIGN KEY (\`root_turn_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_delegation_root_session_id_session_id_fk\` FOREIGN KEY (\`root_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_delegation_task_message_id_message_id_fk\` FOREIGN KEY (\`task_message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_delegation_task_part_id_part_id_fk\` FOREIGN KEY (\`task_part_id\`) REFERENCES \`part\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_review_delegation_task_idx\` ON \`permission_review_delegation\` (\`task_message_id\`,\`task_call_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`permission_review_delegation_child_session_idx\` ON \`permission_review_delegation\` (\`child_session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`permission_review_delegation_root_turn_idx\` ON \`permission_review_delegation\` (\`root_turn_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
