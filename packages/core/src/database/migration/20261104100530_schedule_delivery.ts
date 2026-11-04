import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261104100530_schedule_delivery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`schedule\` ADD \`delivery\` text;`)
    })
  },
}

export default migration
