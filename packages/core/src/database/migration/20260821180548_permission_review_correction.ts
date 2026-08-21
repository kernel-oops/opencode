import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260821180548_permission_review_correction",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`permission_review_correction\` (
          \`turn_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_permission_review_correction_turn_id_message_id_fk\` FOREIGN KEY (\`turn_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_permission_review_correction_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`permission_review_correction_session_idx\` ON \`permission_review_correction\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
