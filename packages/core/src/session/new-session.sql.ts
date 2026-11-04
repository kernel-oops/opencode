import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { SessionSchema } from "./schema.js"
import type { SessionMessage } from "./message.js"
export { Table as SessionDelegationTable } from "./delegation.js"

/** No foreign-key cascades: deleting a Session must never erase an unresolved reservation. */
export const NewSessionTable = sqliteTable(
  "new_session_launch",
  {
    id: text().primaryKey(),
    creator_id: text().$type<SessionSchema.ID>().notNull(),
    launch_key: text().notNull(),
    payload_hash: text().notNull(),
    payload: text().notNull(),
    project_id: text().notNull(),
    ownership_key: text().notNull(),
    canonical: text().notNull(),
    workdir: text().notNull(),
    directory_identity: text().notNull(),
    session_id: text().$type<SessionSchema.ID>().notNull(),
    prompt_id: text().$type<SessionMessage.ID>().notNull(),
    notification_id: text().$type<SessionMessage.ID>().notNull(),
    stage: text()
      .$type<
        "reserved" | "creating" | "created" | "admitted" | "starting" | "running" | "execution-ended" | "accepted"
      >()
      .notNull(),
    terminal: text().$type<"succeeded" | "failed" | "interrupted">(),
    notification_admitted: integer({ mode: "boolean" }).notNull().default(false),
    evidence: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("new_session_creator_key").on(table.creator_id, table.launch_key),
    uniqueIndex("new_session_owner")
      .on(table.project_id, table.ownership_key)
      .where(sql`${table.stage} <> 'accepted'`),
    uniqueIndex("new_session_workdir")
      .on(table.workdir)
      .where(sql`${table.stage} <> 'accepted'`),
  ],
)
