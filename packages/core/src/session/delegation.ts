export * as SessionDelegation from "./delegation.js"

import { eq } from "drizzle-orm"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Context, Effect, Option, Schema } from "effect"
import type { Permission } from "@opencode/schema/permission"
import type { Event } from "@opencode/schema/event"
import type { Agent } from "@opencode/schema/agent"
import { Model } from "../model.js"
import { ModelResolver } from "../model-resolver.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Location } from "../location.js"
import { AbsolutePath } from "../schema.js"
import { SessionTable } from "./sql.js"
import { SessionSchema } from "./schema.js"
import type { Database } from "../database/database.js"
import { NewSessionTable } from "./new-session.sql.js"
import { ClientModelSelection } from "./client-model-selection.js"
type DB = Database.Interface["db"] | Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

/** Core provenance is deliberately outside user-editable Session metadata and permissions. */
export const Table = sqliteTable("session_delegation", {
  session_id: text().$type<SessionSchema.ID>().primaryKey(),
  origin_id: text().$type<SessionSchema.ID>().notNull(),
  creator_id: text().$type<SessionSchema.ID>().notNull(),
  source_agent: text().$type<Agent.ID>().notNull(),
  source_directory: text().notNull(),
  source_directory_identity: text().notNull(),
  agent_rules: text({ mode: "json" }).$type<Permission.Ruleset>().notNull(),
  session_rules: text({ mode: "json" }).$type<Permission.Ruleset>().notNull(),
  target_agent: text().$type<Agent.ID>().notNull(),
  target_model: text({ mode: "json" }).$type<Model.Ref>().notNull(),
  // Native client baseline is session-local; the original delegation target remains immutable.
  client_model: text({ mode: "json" }).$type<Model.Ref>(),
})

export const get = (db: DB, sessionID: SessionSchema.ID) =>
  db.select().from(Table).where(eq(Table.session_id, sessionID)).get().pipe(Effect.orDie)

/** Read-only plugin evidence boundary; stored delegation wins over editable metadata and parent links. */
export const authorityProof = Effect.fn("SessionDelegation.authorityProof")(function* (
  db: DB,
  subject: SessionSchema.ID,
) {
  let current = subject
  const seen = new Set<SessionSchema.ID>()
  const ancestry = []
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(current)) return { complete: false as const }
    seen.add(current)
    const delegation = yield* get(db, current)
    const session = yield* db.select().from(SessionTable).where(eq(SessionTable.id, current)).get().pipe(Effect.orDie)
    if (!session) return { complete: false as const }
    const authority = {
      id: session.id,
      created: session.time_created,
      projectID: session.project_id,
      parentID: session.parent_id,
      directory: session.directory,
      workspaceID: session.workspace_id,
      subpath: session.path,
      agent: session.agent,
      model: session.model,
      permissions: session.permission,
      forkSessionID: session.fork_session_id,
      forkBoundary: session.fork_boundary,
      revert: session.revert,
      archived: session.time_archived,
    }
    if (delegation) {
      const origin = yield* db
        .select()
        .from(NewSessionTable)
        .where(eq(NewSessionTable.session_id, delegation.origin_id))
        .get()
        .pipe(Effect.orDie)
      if (
        !origin ||
        origin.stage === "accepted" ||
        origin.session_id !== delegation.origin_id ||
        origin.creator_id !== delegation.creator_id ||
        origin.project_id !== session.project_id
      )
        return { complete: false as const }
      ancestry.push({
        authority,
        delegation,
        origin: {
          id: origin.id,
          sessionID: origin.session_id,
          creatorID: origin.creator_id,
          projectID: origin.project_id,
          canonical: origin.canonical,
          workdir: origin.workdir,
          directoryIdentity: origin.directory_identity,
          accepted: false,
          ownershipKey: origin.ownership_key,
        },
      })
      // The owner's initial user-typed prompt is agent-authored, including already persisted briefs.
      current = delegation.creator_id
      continue
    }
    ancestry.push({ authority })
    if (session.parent_id) {
      current = session.parent_id
      continue
    }
    return { complete: true as const, sessionID: current, ancestry }
  }
  return { complete: false as const }
})

/** Keep the public plugin evidence shape unchanged; the private proof binds the whole walk. */
export const reviewRoot = Effect.fn("SessionDelegation.reviewRoot")(function* (db: DB, subject: SessionSchema.ID) {
  const proof = yield* authorityProof(db, subject)
  return proof.complete ? { complete: true as const, sessionID: proof.sessionID } : { complete: false as const }
})

export class BlockedError extends Schema.TaggedError<BlockedError>()("Session.DelegationBlockedError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

/** Called inside the creation/fork projection transaction, before the child can execute. */
export const inherit = Effect.fn("SessionDelegation.inherit")(function* (
  db: DB,
  sourceID: SessionSchema.ID,
  sessionID: SessionSchema.ID,
) {
  const source = yield* get(db, sourceID)
  if (!source) return
  yield* open(db, sourceID)
  yield* db
    .insert(Table)
    .values({ ...source, session_id: sessionID, client_model: null })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/** Expected preflight rejection; projection callers retain the defect-channel fence below. */
const assertOpen = Effect.fn("SessionDelegation.assertOpen")(function* (db: DB, sessionID: SessionSchema.ID) {
  const source = yield* get(db, sessionID)
  if (!source) return
  const origin = yield* db
    .select()
    .from(NewSessionTable)
    .where(eq(NewSessionTable.session_id, source.origin_id))
    .get()
    .pipe(Effect.orDie)
  if (!origin || origin.stage === "accepted")
    return yield* new BlockedError({
      sessionID,
      message: "Delegated ownership is closed or unknown; further work is fenced",
    })
})

/** Checked inside mutation transactions, so closing and new work cannot race. */
export const open = Effect.fn("SessionDelegation.open")((db: DB, sessionID: SessionSchema.ID) =>
  assertOpen(db, sessionID).pipe(Effect.orDie),
)

/** Fail closed at the core transition boundary, including direct API callers. */
export const protect = Effect.fn("SessionDelegation.protect")(function* (db: DB, sessionID: SessionSchema.ID) {
  if (yield* get(db, sessionID))
    return yield* new BlockedError({ sessionID, message: "Delegated Session identity and placement cannot be changed" })
})

/** Fresh stored placement and provenance are the authority, never event.previous or metadata. */
export const assertModelTransition = Effect.fn("SessionDelegation.assertModelTransition")(function* (
  db: DB,
  sessionID: SessionSchema.ID,
  requested: Model.Ref,
  reserved = false,
  eventID?: Event.ID,
) {
  const provenance = yield* get(db, sessionID)
  if (!provenance) return
  if (!reserved) yield* assertOpen(db, sessionID)
  const blocked = new BlockedError({
    sessionID,
    message: "Delegated model changes must preserve the configured model and change only reasoning effort",
  })
  const current = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  if (!current || (sessionID === provenance.origin_id && !current.model)) return yield* blocked
  const locations = yield* Effect.serviceOption(LocationServiceMap.Service)
  if (Option.isNone(locations)) return yield* blocked
  // Never start a cold provider/plugin graph within a projection transaction.
  const cached = yield* locations.value.contextEffectOption(
    Location.Ref.make({
      directory: AbsolutePath.make(current.directory),
      workspaceID: current.workspace_id ?? undefined,
    }),
  )
  if (Option.isNone(cached)) return yield* blocked
  const models = Context.getOption(cached.value, Model.Service)
  if (Option.isNone(models)) return yield* blocked
  const catalogue = yield* models.value.available()
  const model = catalogue.find((model) => model.providerID === requested.providerID && model.id === requested.id)
  if (!model || !model.enabled) return yield* blocked
  if (yield* ClientModelSelection.matches(sessionID, requested, eventID)) {
    yield* ModelResolver.withVariant(model, requested.variant).pipe(Effect.mapError(() => blocked))
    return
  }
  const configuredDefault = current.model ? undefined : yield* models.value.default()
  // Match normal resolver fallback; an unset child does not use the agent's model.
  const fallback =
    configuredDefault && ModelResolver.hasPackage(configuredDefault)
      ? configuredDefault
      : catalogue.find((model) => ModelResolver.hasPackage(model) && Model.supportsText(model))
  const baseline = provenance.client_model ?? provenance.target_model
  const previous = reserved
    ? baseline
    : (current.model ?? (fallback ? { id: fallback.id, providerID: fallback.providerID } : undefined))
  if (!previous || previous.providerID !== requested.providerID || previous.id !== requested.id) return yield* blocked
  if (
    sessionID === provenance.origin_id &&
    (requested.providerID !== baseline.providerID || requested.id !== baseline.id)
  )
    return yield* blocked
  const valid = yield* ModelResolver.effortTransition(
    model,
    Model.VariantID.make(previous.variant ?? "default"),
    requested.variant,
  ).pipe(Effect.catchTag("SessionRunnerModel.VariantUnavailableError", () => Effect.succeed(false)))
  if (!valid) return yield* blocked
})
