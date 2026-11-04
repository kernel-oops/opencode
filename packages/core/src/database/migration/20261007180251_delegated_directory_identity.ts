import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261007180251_delegated_directory_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_delegation\` ADD \`source_directory_identity\` text NOT NULL;`)
    })
  },
}

export default migration
