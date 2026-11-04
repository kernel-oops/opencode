import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261023200608_session_context_budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`context_budget\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`context_budget_state\` text;`)
    })
  },
}

export default migration
