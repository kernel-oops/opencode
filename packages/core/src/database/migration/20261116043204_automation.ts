import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261116043204_automation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`automation\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text,
          \`directory\` text NOT NULL,
          \`name\` text NOT NULL,
          \`trigger\` text NOT NULL,
          \`tz\` text NOT NULL,
          \`action\` text NOT NULL,
          \`status\` text DEFAULT 'active' NOT NULL,
          \`next_due_at\` integer,
          \`expires_at\` integer,
          \`run_count\` integer DEFAULT 0 NOT NULL,
          \`failures\` integer DEFAULT 0 NOT NULL,
          \`last_run_at\` integer,
          \`last_message_id\` text,
          \`last_outcome\` text,
          \`last_output\` text,
          \`retry_at\` integer,
          \`state\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`DROP INDEX IF EXISTS \`schedule_session_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`schedule_due_idx\`;`)
      yield* tx.run(`CREATE INDEX \`automation_project_idx\` ON \`automation\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`automation_session_idx\` ON \`automation\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`automation_due_idx\` ON \`automation\` (\`next_due_at\`) WHERE "automation"."status" = 'active' and "automation"."next_due_at" is not null;`,
      )
      // Carry over live schedules that map onto automations unchanged: a prompt into their Session with no `if` or
      // `until` check and no `ends.times` limit. Gated or counted schedules, and finished ones, are dropped, since
      // without their condition or limit they would run differently.
      // Fork: prompts that name the removed schedule tools are rewritten to the automation tools that replace them.
      // Fork: the fork's `delivery` column (queued schedules, 20261104100530_schedule_delivery) moves into the prompt
      // action, and a one-shot (`at` or `in`) with a run limit carries over too, since it runs once either way.
      const prompt = [
        ["tools.opencode.schedule_", "tools.automation."],
        ["opencode_schedule_", "automation_"],
        ...["create", "list", "pause", "resume", "delete"].map((name) => [`schedule_${name}`, `automation_${name}`]),
      ].reduce((sql, [from, to]) => `replace(${sql}, '${from}', '${to}')`, "json_extract(s.`action`, '$.prompt')")
      yield* tx.run(`
        INSERT INTO \`automation\` (
          \`id\`, \`project_id\`, \`session_id\`, \`directory\`, \`name\`, \`trigger\`, \`tz\`, \`action\`, \`status\`,
          \`next_due_at\`, \`expires_at\`, \`run_count\`, \`last_run_at\`, \`last_message_id\`, \`last_outcome\`,
          \`retry_at\`, \`time_created\`, \`time_updated\`
        )
        SELECT
          'aut_' || substr(s.\`id\`, 5),
          v.\`project_id\`,
          s.\`session_id\`,
          v.\`directory\`,
          coalesce(s.\`name\`, substr(json_extract(s.\`action\`, '$.prompt'), 1, 60)),
          CASE json_extract(s.\`when\`, '$.type')
            WHEN 'in' THEN json_object('type', 'at', 'at', strftime('%Y-%m-%dT%H:%M:%fZ', s.\`next_due_at\` / 1000.0, 'unixepoch'))
            ELSE s.\`when\`
          END,
          s.\`tz\`,
          CASE WHEN s.\`delivery\` IS NULL
            THEN json_object('type', 'prompt', 'prompt', ${prompt}, 'to', json_object('session', s.\`session_id\`))
            ELSE json_object('type', 'prompt', 'prompt', ${prompt}, 'to', json_object('session', s.\`session_id\`), 'delivery', s.\`delivery\`)
          END,
          s.\`status\`,
          s.\`next_due_at\`,
          s.\`ends_at\`,
          s.\`run_count\`,
          s.\`last_fired_at\`,
          s.\`last_message_id\`,
          s.\`last_outcome\`,
          s.\`retry_at\`,
          s.\`time_created\`,
          s.\`time_updated\`
        FROM \`schedule\` s
        JOIN \`session_v2\` v ON v.\`id\` = s.\`session_id\`
        WHERE s.\`status\` IN ('active', 'paused')
          AND s.\`check\` IS NULL
          AND (s.\`remaining_runs\` IS NULL OR json_extract(s.\`when\`, '$.type') IN ('at', 'in'))
          AND s.\`next_due_at\` IS NOT NULL;
      `)
      yield* tx.run(`DROP TABLE \`schedule\`;`)
    })
  },
}

export default migration
