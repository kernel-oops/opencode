export * as Permission from "./permission.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { Permission } from "@opencode/schema/permission"
import type { Tool } from "@opencode/schema/tool"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Wildcard } from "./util/wildcard.js"
import { PermissionSaved } from "./permission/saved.js"
import { PluginHooks } from "./plugin/hooks.js"
import { Database } from "./database/database.js"
import { SessionDelegation } from "./session/delegation.js"
import { Git } from "./git.js"
import { verify as verifyProjectAuthority } from "./session/project-authority.js"
import { NewSessionTable } from "./session/new-session.sql.js"
import { eq } from "drizzle-orm"
import { realpath, stat } from "node:fs/promises"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset } from "@opencode/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

function reviewBinding(
  input: Pick<AssertInput, "sessionID" | "agent" | "action" | "resources" | "metadata" | "source">,
) {
  return JSON.stringify([input.sessionID, input.agent, input.action, input.resources, input.metadata, input.source])
}

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export interface AssertInput extends Omit<Request, "id" | "message"> {
  readonly id?: ID
  readonly agent?: Agent.ID
}

/** The requester fields of a permission request made by a tool call. */
export const invocation = (context: Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
})

export interface ReplyInput {
  readonly requestID: ID
  readonly reply: Reply
  readonly message?: string
  /** Limit a rejection to this request; omitted preserves session-wide batch rejection. */
  readonly experimental?: { readonly scope?: "request" }
}

export interface AskResult {
  readonly id: ID
  readonly effect: Permission.Effect
}

export { Event } from "@opencode/schema/permission"

/**
 * Rules that settle a request which would otherwise ask, for work nobody is present to answer, such as a schedule's
 * check. A request they do not allow is denied. Configured denies still win, as they are evaluated first.
 */
export const Unattended = Context.Reference<Permission.Ruleset | undefined>("@opencode/Permission/Unattended", {
  defaultValue: () => undefined,
})

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return this.feedback
  }
}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
  /** Why the request was refused, e.g. "agent God: subagent * deny for Kryten" or "refused by a permission plugin". */
  explanation: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export class InvalidReplyError extends Schema.TaggedError<InvalidReplyError>()("Permission.InvalidReplyError", {
  message: Schema.String,
}) {}

interface Approval {
  readonly receipt: PluginHooks.ModelReceipt
  readonly stamp: string
}

export class ReviewStaleError extends Schema.TaggedError<ReviewStaleError>()("Permission.ReviewStaleError", {
  reasons: Schema.Array(Schema.String),
}) {
  override get message() {
    return "This guarded operation was not authorised because its permission review is stale. Process new input and reassess the scope before attempting a fresh operation. Earlier operations in this tool invocation may already have executed."
  }
}

export type Error = BlockedError | CorrectedError | ReviewStaleError

/**
 * How long any pending permission request waits for the user before it is rejected back to the agent:
 * ordinary asks, reviewer-failure asks, delegated source-review asks, model-refusal review requests and
 * requests created through the external permission API alike.
 */
export const PERMISSION_REQUEST_TIMEOUT = Duration.minutes(2)

/** @deprecated Same value as PERMISSION_REQUEST_TIMEOUT; every pending request now expires. */
export const REVIEW_REQUEST_TIMEOUT = PERMISSION_REQUEST_TIMEOUT

/** Model-facing feedback for an expired model-refusal review request. */
export const REVIEW_REQUEST_EXPIRED_MESSAGE =
  "The permission reviewer referred this call to the user, who did not answer within 2 minutes, so it was rejected and did not run. Carry on with any other work that does not depend on it. Tell the user in plain words exactly what you wanted to do and why. If the user says to go ahead, retry the same call; the retry creates a fresh request for them to answer."

/** Model-facing feedback for any other expired permission request (ordinary, reviewer-failure or delegated ask). */
export const PERMISSION_REQUEST_EXPIRED_MESSAGE =
  "The user did not answer this permission request within 2 minutes, so it was rejected and did not run. Do not stop or wait: carry on with any other work that does not depend on it. Tell the user in plain words exactly what you wanted to do and why. If the user says to go ahead, retry the same call once; the retry creates a fresh request for them to answer."

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

interface Layered {
  readonly rule: Permission.Rule
  /** Where the rule came from: "agent <id>", "missing agent <id>" (the deny-all used when the agent is unknown), or "session". */
  readonly layer: string
}

/** A short, model- and human-readable reason for a rule-based refusal, e.g. "agent God: subagent * deny". */
export function describeRefusal(refused: {
  readonly resource: string
  readonly rule: Permission.Rule
  readonly layer: string
}) {
  const rule = `${refused.rule.action} ${refused.rule.resource} ${refused.rule.effect}`
  const target = refused.resource === "*" ? "" : ` for ${refused.resource}`
  return refused.layer.startsWith("missing agent")
    ? `${refused.layer} could not be found, so everything is refused${target}`
    : `${refused.layer}: ${rule}${target}`
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput, nativeClient?: boolean) => Effect.Effect<void, NotFoundError | InvalidReplyError>
  /** Fails only when the rules deny the request; never asks the user. */
  readonly assertNotDenied: (input: AssertInput) => Effect.Effect<void, BlockedError | SessionErrors.NotFoundError>
  /** True only when the rules already allow the request; never asks the user. */
  readonly allows: (input: AssertInput) => Effect.Effect<boolean, SessionErrors.NotFoundError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError | ReviewStaleError>
  readonly review?: Approval
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const db = (yield* Database.Service).db
    const pending = new Map<ID, Pending>()
    const scope = yield* Effect.scope
    let closed = false

    // Every settlement path (reply, sibling reject, always cascade, expiry, close) first claims the entry
    // synchronously; only the claimant may publish a reply for it or settle its deferred, so each request is
    // settled exactly once and a request claimed by expiry can never be approved or executed.
    const claim = (item: Pending) => {
      if (pending.get(item.request.id) !== item) return false
      pending.delete(item.request.id)
      return true
    }

    const close = Effect.gen(function* () {
      closed = true
      yield* Effect.forEach(Array.from(pending.values()), (item) =>
        Effect.suspend(() =>
          claim(item)
            ? bus
                .publish(Permission.Event.Replied, {
                  sessionID: item.request.sessionID,
                  requestID: item.request.id,
                  reply: "reject",
                })
                .pipe(Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError())))
            : Effect.void,
        ),
      )
      pending.clear()
    }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() => close)

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    // The rules an assertion is decided by, each tagged with the layer it came from so a refusal can say why.
    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const id = agentID ?? session.agent
      const agent = yield* agents.resolve(id)
      const layered: Layered[] = [
        ...(agent?.permissions ?? missingAgentPermissions).map((rule) => ({
          rule,
          layer: agent ? (`agent ${agent.id}` as const) : (`missing agent ${id ?? "(none)"}` as const),
        })),
        ...(session.permissions ?? []).map((rule) => ({ rule, layer: "session" })),
      ]
      return { rules: layered.map((item) => item.rule), layered, agent: id, resolved: agent !== undefined }
    })

    /** The first refused resource and the rule that refused it, or undefined when nothing is refused. */
    function refusal(input: Pick<Request, "action" | "resources">, layered: ReadonlyArray<Layered>) {
      for (const resource of input.resources) {
        const decided = layered.findLast(
          (item) => Wildcard.match(input.action, item.rule.action) && Wildcard.match(resource, item.rule.resource),
        )
        if (decided?.rule.effect === "deny") return { resource, ...decided }
      }
      return undefined
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const git = yield* Git.Service
    // Preserve lineage authority without treating live chat as a permission veto.
    const reviewContext = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const proof = yield* SessionDelegation.authorityProof(tx, sessionID)
            return {
              complete: proof.complete,
              root: JSON.stringify(
                proof.complete
                  ? {
                      ...proof,
                      ancestry: proof.ancestry.map((item) => ({
                        ...item,
                        authority: { ...item.authority, revert: undefined },
                      })),
                    }
                  : proof,
              ),
            }
          }),
        )
        .pipe(Effect.orDie)
    })
    const sourcePolicy = Effect.fnUntraced(function* (input: AssertInput) {
      const delegation = yield* SessionDelegation.get(db, input.sessionID)
      let ceilingAsk = false
      if (delegation) {
        const origin = yield* db
          .select({
            id: NewSessionTable.id,
            sessionID: NewSessionTable.session_id,
            creatorID: NewSessionTable.creator_id,
            canonical: NewSessionTable.canonical,
            projectID: NewSessionTable.project_id,
            stage: NewSessionTable.stage,
            workdir: NewSessionTable.workdir,
            directoryIdentity: NewSessionTable.directory_identity,
          })
          .from(NewSessionTable)
          .where(eq(NewSessionTable.session_id, delegation.origin_id))
          .get()
          .pipe(Effect.orDie)
        const source = yield* sessions.get(delegation.creator_id)
        const target = yield* sessions.get(input.sessionID)
        const sourceAgent = yield* agents.resolve(delegation.source_agent)
        const repositoryIdentity = origin
          ? yield* verifyProjectAuthority(git, origin.projectID, delegation.source_directory, origin.workdir).pipe(Effect.orElseSucceed(() => false))
          : false
        const workdirIdentity = origin
          ? yield* Effect.tryPromise({
              try: async () => {
                if ((await realpath(origin.workdir)) !== origin.workdir) return undefined
                const info = await stat(origin.workdir)
                return `${info.dev}:${info.ino}`
              },
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        const directoryIdentity = yield* Effect.tryPromise({
          try: async () => {
            if ((await realpath(delegation.source_directory)) !== delegation.source_directory) return undefined
            const info = await stat(delegation.source_directory)
            return `${info.dev}:${info.ino}`
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
        const failures: string[] = []
        if (!source) failures.push(`creator session ${delegation.creator_id} no longer exists`)
        if (!target) failures.push(`target session ${input.sessionID} no longer exists`)
        if (!sourceAgent) failures.push(`source agent ${delegation.source_agent} no longer exists`)
        if (sourceAgent?.hidden) failures.push(`source agent ${delegation.source_agent} is hidden`)
        if (source && source.agent !== delegation.source_agent) failures.push(`creator session ${delegation.creator_id} agent changed`)
        if (source?.parentID) failures.push(`creator session ${delegation.creator_id} has a parent`)
        if (source && source.location.directory !== delegation.source_directory) failures.push(`creator session ${delegation.creator_id} directory changed`)
        if (location.directory !== delegation.source_directory) failures.push(`current directory ${location.directory} differs from ${delegation.source_directory}`)
        if (directoryIdentity !== delegation.source_directory_identity) failures.push(`source directory ${delegation.source_directory} missing or replaced (expected dev:ino ${delegation.source_directory_identity}, found ${directoryIdentity ?? "missing"})`)
        if (!repositoryIdentity) failures.push(`project identity or write-directory association for ${delegation.source_directory} is invalid`)
        if (workdirIdentity !== origin?.directoryIdentity) failures.push(`workdir ${origin?.workdir} missing or replaced (expected dev:ino ${origin?.directoryIdentity}, found ${workdirIdentity ?? "missing"})`)
        if (!origin) failures.push(`launch for session ${delegation.origin_id} no longer exists`)
        if (origin && origin.sessionID !== delegation.origin_id) failures.push(`launch session does not match ${delegation.origin_id}`)
        if (origin && origin.creatorID !== delegation.creator_id) failures.push(`launch creator does not match ${delegation.creator_id}`)
        if (origin && origin.canonical !== delegation.source_directory) failures.push(`launch canonical directory does not match ${delegation.source_directory}`)
        if (origin?.stage === "accepted") failures.push(`launch ${origin.id} already accepted`)
        if (origin && source && origin.projectID !== source.projectID) failures.push(`launch and creator project IDs differ`)
        if (origin && origin.projectID !== location.project.id) failures.push(`launch and current project IDs differ`)
        if (target && source && target.projectID !== source.projectID) failures.push(`target and creator project IDs differ`)
        if (target && target.location.directory !== delegation.source_directory) failures.push(`target session ${input.sessionID} directory differs from ${delegation.source_directory}`)
        const identity = failures.length === 0 && source && target && sourceAgent && origin
        // Intersect layers; an allow in a copied/current Session rule list must never
        // turn an immutable source-agent deny into an allow through last-match ordering.
        const ceilings = identity ? [delegation.agent_rules, sourceAgent.permissions] : [missingAgentPermissions]
        const sessionCeilings = identity ? [delegation.session_rules, source.permissions ?? []] : []
        const layers = (resource: string) => [
          ...ceilings,
          ...sessionCeilings.filter((rules) =>
            rules.some((rule) => Wildcard.match(input.action, rule.action) && Wildcard.match(resource, rule.resource)),
          ),
        ]
        let reason: string | undefined
        if (!identity) reason = `delegated session identity no longer valid: ${failures.join("; ")}`
        else if (input.action === "new_session") reason = "delegated sessions cannot create new sessions"
        else {
          const named = [
            { rules: delegation.agent_rules, layer: "delegated agent rules" },
            { rules: sourceAgent.permissions, layer: `source agent ${delegation.source_agent} permissions` },
            { rules: delegation.session_rules, layer: "delegated session rules" },
            { rules: source.permissions ?? [], layer: `source session ${delegation.creator_id} rules` },
          ]
          for (const resource of input.resources) {
            for (const [index, { rules, layer }] of named.entries()) {
              // Session layers are evaluated only when a rule matches.
              if (index >= 2 && !rules.some((rule) => Wildcard.match(input.action, rule.action) && Wildcard.match(resource, rule.resource))) continue
              const rule = evaluate(input.action, resource, rules)
              if (rule.effect === "deny") {
                reason = `${layer}: ${input.action} ${resource} denied by rule ${rule.action} ${rule.resource}`
                break
              }
            }
            if (reason) break
          }
        }
        const denied = input.action === "new_session" || input.resources.some((resource) =>
          layers(resource).some((rules) => evaluate(input.action, resource, rules).effect === "deny"),
        )
        ceilingAsk = input.resources.some((resource) =>
          layers(resource).some((rules) => evaluate(input.action, resource, rules).effect === "ask"),
        )
        return {
          denied,
          reason,
          ask: ceilingAsk,
          rules: [...ceilings, ...sessionCeilings].flat(),
          agent: delegation.source_agent,
          fingerprint: JSON.stringify([
            delegation,
            origin ? { ...origin, stage: origin.stage === "accepted" ? "accepted" : "open" } : undefined,
            { resolved: sourceAgent !== undefined, hidden: sourceAgent?.hidden },
            sourceAgent?.permissions,
            directoryIdentity,
            workdirIdentity,
            repositoryIdentity,
          ]),
        }
      }
      return { denied: false, reason: undefined, ask: false, rules: [], agent: undefined, fingerprint: "none" }
    })
    const evaluateInput = Effect.fnUntraced(function* (provided: AssertInput, approval?: Approval) {
      // Allocate and freeze the request binding before any asynchronous review. Hooks receive copies.
      const input = structuredClone({ ...provided, id: provided.id ?? ID.create() })
      if (closed) return { effect: "deny" as const, rules: [], message: undefined, reason: "permission owner is closed" }
      const ceiling = structuredClone(yield* sourcePolicy(input))
      const context = yield* reviewContext(input.sessionID)
      const reviewerRevision = hooks.revision()
      if (ceiling.denied)
        return {
          effect: "deny" as const,
          rules: ceiling.rules,
          message: undefined,
          reason: ceiling.reason,
        }
      const decided = structuredClone(yield* configured(input.sessionID, input.agent))
      const refused = refusal(input, decided.layered)
      if (refused) {
        const reason = describeRefusal(refused)
        yield* Effect.logInfo("permission refused by rule", {
          sessionID: input.sessionID,
          agent: decided.agent,
          agentResolved: decided.resolved,
          action: input.action,
          resources: input.resources,
          resource: refused.resource,
          rule: refused.rule,
          layer: refused.layer,
        })
        // Observation only: plugins may record the refusal but cannot overturn a configured deny.
        yield* hooks.trigger("permission", "evaluate", {
          sessionID: input.sessionID,
          agent: input.agent,
          action: input.action,
          resources: input.resources,
          metadata: input.metadata,
          source: input.source,
          effect: "deny",
          refusal: reason,
        })
        return { effect: "deny" as const, rules: decided.rules, message: undefined, reason }
      }
      const all = [...decided.rules, ...(yield* savedRules())]
      const stamp = JSON.stringify([ceiling.fingerprint, decided, all, context.root, reviewerRevision, reviewBinding(input)])
      if (approval && (!context.complete || approval.stamp !== stamp || !approval.receipt.valid()))
        return { effect: "stale" as const, rules: all, message: undefined, reason: undefined, staleReasons: ["manualReviewChanged"] }
      const effects = input.resources.map(
        (resource) =>
          evaluate(
            input.action,
            resource,
            input.action === "new_session" ? all.filter((rule) => rule.action === "new_session") : all,
          ).effect,
      )
      const effect: Permission.Effect = effects.includes("ask") ? "ask" : "allow"
      const target = yield* hooks.reviewPermission(
        structuredClone({
          sessionID: input.sessionID,
          agent: input.agent,
          action: input.action,
          resources: input.resources,
          metadata: input.metadata,
          source: input.source,
          effect,
        }), false, approval?.receipt,
      )
      const event = target.event
      const reviewed =
        ceiling.ask && event.effect !== "deny"
          ? yield* hooks.reviewPermission(
              structuredClone({
                sessionID: input.sessionID,
                agent: ceiling.agent,
                action: input.action,
                resources: input.resources,
                metadata: input.metadata,
                source: input.source,
                effect: "ask" as const,
              }), true, approval?.receipt,
            )
          : undefined
      // No awaited reviewer can outlive a tightened policy, closed owner or changed placement.
      const currentCeiling = yield* sourcePolicy(input)
      if (closed) return { effect: "deny" as const, rules: [], message: undefined, reason: "permission owner is closed" }
      if (currentCeiling.denied)
        return {
          effect: "deny" as const,
          rules: currentCeiling.rules,
          message: undefined,
          reason: currentCeiling.reason,
        }
      const current = yield* configured(input.sessionID, input.agent)
      const currentRefused = refusal(input, current.layered)
      if (currentCeiling.denied || currentRefused || (reviewed?.event.effect === "deny" && !reviewed.review))
        return {
          effect: "deny" as const,
          rules: [...current.rules, ...currentCeiling.rules],
          message: reviewed?.event.message,
          reason: currentRefused
            ? describeRefusal(currentRefused)
            : "delegated source review or current policy refused the action",
        }
      const currentAll = [...current.rules, ...(yield* savedRules())]
      const currentContext = yield* reviewContext(input.sessionID)
      const changes = {
        sourceAuthorityChanged: ceiling.fingerprint !== currentCeiling.fingerprint,
        configuredPolicyChanged: JSON.stringify(decided) !== JSON.stringify(current),
        savedPolicyChanged:
          JSON.stringify(all.slice(decided.rules.length)) !== JSON.stringify(currentAll.slice(current.rules.length)),
        reviewerRevisionChanged: reviewerRevision !== hooks.revision(),
        rootProofChanged: context.root !== currentContext.root,
      }
      const unchanged = !Object.values(changes).some(Boolean)
      const requestBindingUnchanged =
        reviewBinding(event) === reviewBinding(input) &&
        (!reviewed || reviewBinding(reviewed.event) === reviewBinding({ ...input, agent: ceiling.agent }))
      const receiptValid = (reviewed?.valid() ?? false) && requestBindingUnchanged
      const sourceAllowed = !ceiling.ask || (reviewed?.event.effect === "allow" && receiptValid) || (approval !== undefined && reviewed?.event.effect !== "deny" && receiptValid)
      const marker = target.review ?? reviewed?.review
      const action = input.metadata?.action
      const complete = input.source?.type === "tool" && input.source.id.length > 0 && input.source.messageID.length > 0 &&
        typeof action === "object" && action !== null && "complete" in action && action.complete === true &&
        "identity" in action && typeof action.identity === "string" && action.identity.length > 0 &&
        "arguments" in action && action.arguments !== undefined &&
        "cwd" in action && typeof action.cwd === "string" && action.cwd.length > 0
      const manual = !approval && context.complete && marker && marker.valid() && complete && requestBindingUnchanged && unchanged
        ? { receipt: marker, stamp }
        : undefined
      if (event.effect === "deny") {
        yield* Effect.logInfo("permission refused by plugin hook", {
          sessionID: input.sessionID,
          agent: decided.agent,
          action: input.action,
          resources: input.resources,
          ruleEffect: effect,
          message: event.message,
        })
      }
      const reason =
        event.effect === "deny"
          ? `refused by a permission plugin${event.message ? `: ${event.message}` : ""}`
          : undefined
      const staleReasons = [
        ...Object.entries(changes).flatMap(([reason, changed]) => (changed ? [reason] : [])),
        ...(!requestBindingUnchanged ? ["requestBindingChanged"] : []),
        ...(ceiling.ask && reviewed?.event.effect === "allow" && !receiptValid ? ["invalidSourceReceipt"] : []),
      ]
      const finalEffect =
        event.effect === "deny" || reviewed?.event.effect === "deny"
          ? ("deny" as const)
          : staleReasons.length
            ? ("stale" as const)
            : !sourceAllowed
              ? ("ask" as const)
              : event.effect
      yield* Effect.logInfo(ceiling.ask ? "delegated permission source review" : "permission review consistency", {
        requestID: input.id,
        sessionID: input.sessionID,
        action: input.action,
        sourceAgent: ceiling.agent,
        targetEffect: event.effect,
        sourceEffect: reviewed?.event.effect ?? "ask",
        receiptValid,
        ...changes,
        requestBindingUnchanged,
        contextUnchanged: unchanged,
        effect: finalEffect,
        disposition: finalEffect,
        staleReasons,
      })
      const unattended = yield* Unattended
      if (finalEffect === "ask" && unattended !== undefined) {
        const allowed = !manual && !reviewed && input.resources.every((resource) =>
          evaluate(input.action, resource, [...all, ...unattended]).effect === "allow")
        if (allowed) return { effect: "allow" as const, rules: all }
        return {
          effect: "deny" as const,
          message: [
            `Permission ${input.action} needs approval, and nobody is present to give it`,
            reviewed?.event.effect === "ask" ? (reviewed.event.message ?? event.message) : event.message,
          ].filter(Boolean).join(". "),
          rules: all,
          reason,
          staleReasons,
        }
      }
      return {
        effect: finalEffect,
        message: reviewed?.event.effect === "ask" ? (reviewed.event.message ?? event.message) : event.message,
        rules: all,
        reason,
        staleReasons,
        review: manual,
      }
    })

    function request(input: AssertInput, message?: string): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        // Tools copy optional inputs straight into metadata; undefined values are not JSON and would
        // fail the HttpApi response encoder when clients list pending requests.
        metadata:
          input.metadata &&
          Object.fromEntries(Object.entries(input.metadata).filter(([, value]) => value !== undefined)),
        source: input.source,
        message,
      }
    }

    // `detached` (external API requests, which nobody in core awaits): the expiry timer is attached in the service
    // scope inside this uninterruptible region, before the request is announced, so no pending request can exist
    // without its timer even if the API caller is interrupted.
    const create = (request: Request, agent?: Agent.ID, review?: Approval, detached = false) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError | ReviewStaleError>()
          const item = { request, agent, deferred, review }
          if (closed) {
            yield* Deferred.fail(deferred, new DeclinedError())
            return item
          }
          if (pending.has(request.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          pending.set(request.id, item)
          if (detached) yield* Effect.forkIn(Effect.interruptible(awaitAnswer(item).pipe(Effect.ignore)), scope)
          yield* bus
            .publish(Permission.Event.Asked, request)
            .pipe(
              Effect.onError(() =>
                Effect.suspend(() => (claim(item) ? Deferred.fail(deferred, new DeclinedError()) : Effect.void)),
              ),
            )
          return item
        }),
      )

    // Rejects an unanswered request exactly once. Whoever removes the pending entry first
    // (reply, close or this expiry) owns its resolution; a later reply finds nothing and fails NotFound.
    const expire = (item: Pending) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (closed || !claim(item)) return
          yield* Effect.logInfo("permission request expired", {
            requestID: item.request.id,
            sessionID: item.request.sessionID,
            action: item.request.action,
            kind: item.review ? "model-refusal" : "ask",
          })
          yield* bus
            .publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "reject",
            })
            .pipe(Effect.ensuring(Deferred.fail(item.deferred, new CorrectedError({ feedback: item.review ? REVIEW_REQUEST_EXPIRED_MESSAGE : PERMISSION_REQUEST_EXPIRED_MESSAGE }))))
        }),
      )

    // The timer lives only while the request is awaited: an answer, abort or shutdown ends it with the await.
    const awaitAnswer = (item: Pending): Effect.Effect<void, DeclinedError | CorrectedError | ReviewStaleError> =>
      Deferred.await(item.deferred).pipe(
        Effect.timeoutOrElse({
          duration: PERMISSION_REQUEST_TIMEOUT,
          orElse: () => expire(item).pipe(Effect.andThen(Deferred.await(item.deferred))),
        }),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      input = structuredClone({ ...input, id: input.id ?? ID.create() })
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      const result = yield* evaluateInput(input)
      const value = request(input, result.message)
      if (result.effect === "ask") {
        // Nobody in core awaits an externally created request, so its expiry timer runs in the service scope
        // and ends as soon as the request is answered or the service closes.
        yield* create(value, input.agent, undefined, true)
      }
      return { id: value.id, effect: result.effect === "stale" ? ("deny" as const) : result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        input = structuredClone({ ...input, id: input.id ?? ID.create() })
        if (closed) return yield* Effect.die(new DeclinedError())
        const result = yield* evaluateInput(input)
        if (result.effect === "stale") return yield* new ReviewStaleError({ reasons: result.staleReasons })
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (result.effect === "deny" && !result.review) {
              return yield* new BlockedError({
                rules: relevant(input, result.rules),
                permission: input.action,
                resources: input.resources,
                reason:
                  result.message ??
                  (result.reason ? `Permission denied: ${input.action} (${result.reason})` : undefined),
                explanation: result.reason,
              })
            }
            if (result.effect === "allow") return
            const value = request(input, result.message)
            const item = yield* create(result.review ? { ...value, review: { kind: "model-refusal", reason: result.review.receipt.reason } } : value, input.agent, result.review)
            return yield* restore(awaitAnswer(item)).pipe(
              Effect.flatMap(() => evaluateInput(input, item.review)),
              Effect.flatMap((current) =>
                Effect.gen(function* () {
                  if (current.effect === "stale") return yield* new ReviewStaleError({ reasons: current.staleReasons })
                  if (current.effect === "deny")
                    return yield* new BlockedError({
                      rules: relevant(input, current.rules),
                      permission: input.action,
                      resources: input.resources,
                      reason: current.reason,
                    })
                }),
              ),
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              Effect.ensuring(
                Effect.sync(() => {
                  claim(item)
                }),
              ),
            )
          }),
        )
      }),
    )

    const assertNotDenied = Effect.fn("Permission.assertNotDenied")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      if (result.effect !== "deny") return
      return yield* new BlockedError({
        rules: relevant(input, result.rules),
        permission: input.action,
        resources: input.resources,
        reason: result.message,
      })
    })

    const allows = Effect.fn("Permission.allows")(function* (input: AssertInput) {
      if (closed) return false
      return (yield* evaluateInput(input)).effect === "allow"
    })

    const reply = Effect.fn("Permission.reply")((input: ReplyInput, nativeClient = false) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          if (input.reply !== "reject" && (existing.review ? input.reply !== "review_once" || !nativeClient : input.reply === "review_once"))
            return yield* new InvalidReplyError({ message: "This permission disposition is not valid for this request or client." })
          // Claim the existing deferred before publishing: simultaneous clients, a racing expiry, a sibling
          // batch or an always cascade cannot also settle it.
          claim(existing)
          const declined = () => (input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError())

          if (input.reply === "reject") {
            yield* bus
              .publish(Permission.Event.Replied, {
                sessionID: existing.request.sessionID,
                requestID: existing.request.id,
                reply: input.reply,
              })
              .pipe(Effect.ensuring(Deferred.fail(existing.deferred, declined())))
            if (input.experimental?.scope === "request") return
            for (const item of Array.from(pending.values())) {
              if (item.request.sessionID !== existing.request.sessionID || !claim(item)) continue
              // Feedback applies to the whole batch, so parallel asks don't end the step.
              yield* bus
                .publish(Permission.Event.Replied, {
                  sessionID: item.request.sessionID,
                  requestID: item.request.id,
                  reply: "reject",
                })
                .pipe(Effect.ensuring(Deferred.fail(item.deferred, declined())))
            }
            return
          }

          // An approval that cannot be announced or saved does not run.
          yield* Effect.gen(function* () {
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              reply: input.reply,
            })
            if (input.reply === "always" && existing.request.save?.length) {
              yield* saved.add({
                projectID: location.project.id,
                action: existing.request.action,
                resources: existing.request.save,
              })
            }
          }).pipe(Effect.onError(() => Deferred.fail(existing.deferred, new DeclinedError())))
          yield* Deferred.succeed(existing.deferred, undefined)
          if (input.reply !== "always" || !existing.request.save?.length) return

          for (const item of Array.from(pending.values())) {
            if (item.review || pending.get(item.request.id) !== item) continue
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            if (result?.effect !== "stale" && result?.effect !== "allow") continue
            // Re-claim after the asynchronous evaluation: expiry, an answer, abort or close may own it by now.
            if (!claim(item)) continue
            if (result.effect === "stale") {
              yield* bus
                .publish(Permission.Event.Replied, {
                  sessionID: item.request.sessionID,
                  requestID: item.request.id,
                  reply: "reject",
                })
                .pipe(Effect.ensuring(Deferred.fail(item.deferred, new ReviewStaleError({ reasons: result.staleReasons }))))
              continue
            }
            yield* bus
              .publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "always",
              })
              .pipe(Effect.onError(() => Deferred.fail(item.deferred, new DeclinedError())))
            yield* Deferred.succeed(item.deferred, undefined)
          }
        }),
      ),
    )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, assertNotDenied, allows, reply, get, forSession, list, close })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Location.node,
    Agent.node,
    SessionStore.node,
    PermissionSaved.node,
    PluginHooks.node,
    Database.node,
    Git.node,
  ],
})
