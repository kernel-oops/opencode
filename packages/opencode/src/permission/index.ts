import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPermissionReviewerV1 } from "@opencode-ai/core/v1/config/permission-reviewer"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Cause, Clock, Deferred, Effect, Layer, Context, Exit, Option, Scope } from "effect"
import { and, eq } from "drizzle-orm"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PermissionReviewCorrectionTable, SessionTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { Config } from "@/config/config"
import {
  PERMISSION_REVIEW_POLICY_VERSION,
  type PermissionReviewContext,
  type PermissionReviewInput,
} from "@opencode-ai/plugin"
import { BashPermissionEvaluator } from "./bash-evaluator"
import { safeReviewValue } from "./review"
import { PermissionReviewer } from "./reviewer"
import { InstanceRef } from "@/effect/instance-ref"
import { buildPermissionReviewSnapshot, validPermissionReviewAdmission, type EvidenceInput } from "./reviewer-input"
import { auditCorrelationKey } from "./audit-correlation"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  readonly captureTurn: (input: {
    sessionID: PermissionV1.Request["sessionID"]
    rootSessionID: PermissionV1.Request["sessionID"]
    turnID: string
    trusted: readonly EvidenceInput[]
    untrusted: readonly EvidenceInput[]
    complete?: boolean
    contextSafeForGate?: boolean
  }) => Effect.Effect<void>
  readonly captureUntrusted: (input: { sessionID: string; evidence: readonly EvidenceInput[] }) => Effect.Effect<void>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface ReviewLease {
  settled: boolean
  completed: boolean
}

interface ActiveReviewerRun {
  readonly run: { abort: () => void }
}

type RewriteState =
  | { readonly status: "available" }
  | { readonly status: "claimed"; readonly token: number }
  | { readonly status: "persisting"; readonly token: number }
  | { readonly status: "used" }

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  reviews: Set<ReviewLease>
  reviewerRuns: Set<ActiveReviewerRun>
  scope: Scope.Scope
  disposed: boolean
  project: PermissionReviewContext["project"]
  turns: Map<
    string,
    {
      trusted: EvidenceInput[]
      untrusted: EvidenceInput[]
      rootSessionID: string
      turnID: string
      directPromptAdmission: boolean
      rewrite: RewriteState
      trustedComplete: boolean
      untrustedComplete: boolean
      contextSafeForGate: boolean
    }
  >
}

const MAX_EVIDENCE_ITEMS = 64
const MAX_EVIDENCE_BYTES = 8 * 1024
const MAX_TRUSTED_EVIDENCE_BYTES = 40 * 1024
const MAX_EVIDENCE_SESSIONS = 64
let rewriteClaim = 0

export const REVIEW_TIMEOUT = "30 seconds"
export const REVIEW_CAPACITY = 4

type ReviewResult =
  | "allow"
  | "ask"
  | "deny"
  | "rewrite"
  | "human_review"
  | "timeout"
  | "error"
  | "capacity"
  | "interrupted"
  | PermissionReviewer.Failure

type BuiltinResult = PermissionReviewer.AssessmentResult

function safeReviewString(value: string) {
  const result = safeReviewValue(value)
  return typeof result === "string" ? result : "[UNREADABLE]"
}

function correlation(info: PermissionV1.Request, origin: PermissionReviewContext["origin"]) {
  if (!info.tool) return
  return auditCorrelationKey({
    sessionID: info.sessionID,
    messageID: info.tool.messageID,
    callID: info.tool.callID,
    permission: info.permission,
    origin,
  })
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const plugin = yield* Plugin.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const reviewer = yield* PermissionReviewer.Service
    const bashEvaluator = yield* BashPermissionEvaluator.Service
    const { db } = yield* Database.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          reviews: new Set<ReviewLease>(),
          reviewerRuns: new Set<ActiveReviewerRun>(),
          scope,
          disposed: false,
          project: {
            id: ctx.project.id,
            directory: ctx.directory,
            worktree: ctx.worktree,
          },
          turns: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            state.disposed = true
            for (const active of state.reviewerRuns) active.run.abort()
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
            state.reviews.clear()
            state.reviewerRuns.clear()
            state.turns.clear()
          }),
        )

        return state
      }),
    )

    const boundedEvidence = (items: readonly EvidenceInput[]) => {
      let complete = true
      const bounded = items.slice(-MAX_EVIDENCE_ITEMS).map((item) => {
        if (Buffer.byteLength(item.text, "utf8") <= MAX_EVIDENCE_BYTES) return { ...item }
        complete = false
        let text = item.text
        while (Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_BYTES) {
          const size = Buffer.byteLength(text, "utf8")
          text = text.slice(0, Math.max(0, Math.floor((text.length * MAX_EVIDENCE_BYTES) / size)))
        }
        return { ...item, text }
      })
      if (bounded.length !== items.length) complete = false
      return { items: bounded, complete }
    }

    const boundedTrustedEvidence = (items: readonly EvidenceInput[]) => {
      const withinBudget = Buffer.byteLength(JSON.stringify(items), "utf8") <= MAX_TRUSTED_EVIDENCE_BYTES
      const selected = withinBudget ? items : items.length <= 1 ? items : [items[0], items.at(-1)!]
      const itemBudget = withinBudget
        ? MAX_TRUSTED_EVIDENCE_BYTES
        : Math.floor(MAX_TRUSTED_EVIDENCE_BYTES / Math.max(1, selected.length))
      let complete = withinBudget
      const bounded = selected.map((item) => {
        if (Buffer.byteLength(item.text, "utf8") <= itemBudget) return { ...item }
        complete = false
        let text = item.text
        while (Buffer.byteLength(text, "utf8") > itemBudget) {
          const size = Buffer.byteLength(text, "utf8")
          text = text.slice(0, Math.max(0, Math.floor((text.length * itemBudget) / size)))
        }
        return { ...item, text }
      })
      return { items: bounded, complete }
    }

    const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
      map.delete(key)
      map.set(key, value)
      while (map.size > MAX_EVIDENCE_SESSIONS) map.delete(map.keys().next().value!)
    }

    const captureTurn: Interface["captureTurn"] = Effect.fn("Permission.captureTurn")(function* (input) {
      const current = yield* InstanceState.get(state)
      const trusted = boundedTrustedEvidence(input.trusted)
      const untrusted = boundedEvidence(input.untrusted)
      const persisted = yield* sessions
        .findMessage(input.sessionID, (message) => message.info.role === "user")
        .pipe(Effect.catch(() => Effect.succeed(Option.none())))
      const session = yield* sessions.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const marker = yield* db
        .select({ turnID: PermissionReviewCorrectionTable.turn_id })
        .from(PermissionReviewCorrectionTable)
        .where(
          and(
            eq(PermissionReviewCorrectionTable.session_id, input.sessionID),
            eq(PermissionReviewCorrectionTable.turn_id, MessageID.make(input.turnID)),
          ),
        )
        .get()
        .pipe(Effect.exit)
      const markerHealthy = Exit.isSuccess(marker)
      const correctionUsed = markerHealthy && marker.value !== undefined
      const directPromptAdmission =
        markerHealthy &&
        session !== undefined &&
        session.parentID === undefined &&
        input.rootSessionID === input.sessionID &&
        Option.isSome(persisted) &&
        persisted.value.info.role === "user" &&
        persisted.value.info.id === input.turnID &&
        persisted.value.info.sessionID === input.sessionID &&
        validPermissionReviewAdmission(persisted.value.info.permissionReview?.admission)
      const previous = current.turns.get(input.sessionID)
      const rewrite: RewriteState =
        !markerHealthy || correctionUsed
          ? { status: "used" }
          : previous?.turnID === input.turnID
            ? previous.rewrite
            : { status: "available" }
      remember(current.turns, input.sessionID, {
        trusted: trusted.items,
        untrusted: untrusted.items,
        rootSessionID: input.rootSessionID,
        turnID: input.turnID,
        directPromptAdmission,
        rewrite,
        trustedComplete: (input.complete ?? true) && trusted.complete,
        untrustedComplete: false,
        contextSafeForGate: input.contextSafeForGate === true,
      })
    })

    const persistCorrection = Effect.fn("Permission.persistCorrection")(function* (input: {
      sessionID: PermissionV1.Request["sessionID"]
      turnID: string
    }) {
      const turnID = MessageID.make(input.turnID)
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const session = yield* tx
            .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get()
          if (!session || session.parentID !== null) return "invalid" as const

          const message = yield* tx
            .select({ data: MessageTable.data })
            .from(MessageTable)
            .where(and(eq(MessageTable.id, turnID), eq(MessageTable.session_id, input.sessionID)))
            .get()
          const data: unknown = message?.data
          const review =
            data !== null && typeof data === "object" && !Array.isArray(data) && "permissionReview" in data
              ? data.permissionReview
              : undefined
          const admission =
            review !== null && typeof review === "object" && !Array.isArray(review) && "admission" in review
              ? review.admission
              : undefined
          if (!message || message.data.role !== "user" || !validPermissionReviewAdmission(admission))
            return "invalid" as const

          const existing = yield* tx
            .select({ turnID: PermissionReviewCorrectionTable.turn_id })
            .from(PermissionReviewCorrectionTable)
            .where(eq(PermissionReviewCorrectionTable.turn_id, turnID))
            .get()
          if (existing) return "used" as const

          yield* tx
            .insert(PermissionReviewCorrectionTable)
            .values({ session_id: input.sessionID, turn_id: turnID })
            .run()
          return "inserted" as const
        }),
      )
    })

    const captureUntrusted: Interface["captureUntrusted"] = Effect.fn("Permission.captureUntrusted")(function* (input) {
      const current = yield* InstanceState.get(state)
      const turn = current.turns.get(input.sessionID)
      if (!turn) return
      const untrusted = boundedEvidence([...turn.untrusted, ...input.evidence])
      remember(current.turns, input.sessionID, {
        ...turn,
        untrusted: untrusted.items,
        untrustedComplete: turn.untrustedComplete && untrusted.complete,
      })
    })

    const lineage = Effect.fn("Permission.lineage")(function* (
      info: PermissionV1.Request,
      origin: PermissionReviewContext["origin"],
    ) {
      const fallback = {
        lineage: [info.sessionID],
        complete: false,
        reason: "missing_current" as const,
      }
      const first = yield* sessions.get(info.sessionID).pipe(Effect.exit)
      if (Exit.isFailure(first)) {
        const auditCorrelationKey = correlation(info, origin)
        yield* Effect.logWarning("permission review session context unavailable", {
          permission: info.permission,
          origin,
          ...(auditCorrelationKey ? { auditCorrelationKey } : {}),
        })
        return fallback
      }

      return yield* Session.resolveLineage(sessions, first.value)
    })

    const audit = Effect.fn("Permission.audit")(function* (input: {
      info: PermissionV1.Request
      review: PermissionReviewContext
      result: ReviewResult
      source: "plugin" | "builtin"
      latencyMs: number
      fallbackToHuman: boolean
      reviewSettled: boolean
      policy?: ConfigPermissionReviewerV1.Info["policy"]
      assessment?: PermissionReviewer.ReviewerAssessment
      dispositionAuthority?: "observational" | "automatic_allow" | "automatic_rewrite" | "deny" | "human" | "plugin"
    }) {
      const assessment = input.assessment
      const auditCorrelationKey = correlation(input.info, input.review.origin)
      const outcome =
        assessment?.outcome ??
        (["allow", "ask", "deny", "rewrite", "human_review"].includes(input.result) ? input.result : undefined)
      if (input.source === "builtin") {
        yield* Effect.logInfo("permission review", {
          source: "builtin",
          permission: input.info.permission,
          origin: input.review.origin,
          ...(auditCorrelationKey ? { auditCorrelationKey } : {}),
          policy: input.policy,
          outcome,
          reasonCode: assessment && "reason_code" in assessment ? assessment.reason_code : undefined,
          saferAlternative: assessment && "safer_alternative" in assessment ? assessment.safer_alternative : undefined,
          failure: outcome === undefined ? input.result : undefined,
          dispositionAuthority: input.dispositionAuthority ?? "human",
          latencyMs: input.latencyMs,
        })
        return
      }
      yield* Effect.logInfo("permission review", {
        source: input.source,
        result: input.result,
        dispositionAuthority: input.dispositionAuthority ?? "human",
        latencyMs: input.latencyMs,
      })
    })

    const auditEvaluator = Effect.fn("Permission.auditEvaluator")(function* (input: {
      info: PermissionV1.Request
      review: PermissionReviewContext
      result: BashPermissionEvaluator.Decision | BashPermissionEvaluator.Failure | "interrupted"
      latencyMs: number
      authoritative: boolean
    }) {
      const auditCorrelationKey = correlation(input.info, input.review.origin)
      yield* Effect.logInfo("bash permission evaluator", {
        source: "bash_evaluator",
        permission: input.info.permission,
        origin: input.review.origin,
        ...(auditCorrelationKey ? { auditCorrelationKey } : {}),
        result: input.result,
        latencyMs: input.latencyMs,
        authoritative: input.authoritative,
      })
    })

    const ask: Interface["ask"] = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const instance = yield* InstanceState.context
      const current = yield* InstanceState.get(state)
      const { approved, pending } = current
      const { ruleset, review: source, ...request } = input
      let needsAsk = false
      const rules: PermissionReviewContext["rules"] = []

      for (const [patternIndex, pattern] of request.patterns.entries()) {
        const configured = evaluate(request.permission, pattern, ruleset)
        const learned = evaluate(request.permission, pattern, approved)
        // Learned approvals may satisfy asks, but configured allow/deny decisions remain authoritative.
        const rule = configured.action === "ask" && learned.action === "allow" ? learned : configured
        const reviewedPattern = safeReviewString(pattern)
        const reviewedRule = {
          permission: rule.permission,
          pattern: safeReviewString(rule.pattern),
          action: rule.action,
        }
        rules.push({ pattern: reviewedPattern, action: rule.action, matched: reviewedRule })
        yield* Effect.logInfo("evaluated", {
          permission: request.permission,
          action: rule.action,
          patternIndex,
          patternCount: request.patterns.length,
        })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      const sessionContext = source?.session
        ? { ...source.session, lineage: [...source.session.lineage] }
        : yield* lineage(info, source?.origin ?? "unknown")
      const turn = current.turns.get(info.sessionID) ?? {
        trusted: [],
        untrusted: [],
        rootSessionID: "",
        turnID: "",
        directPromptAdmission: false,
        rewrite: { status: "used" } as RewriteState,
        trustedComplete: false,
        untrustedComplete: false,
        contextSafeForGate: false,
      }
      const snapshot = buildPermissionReviewSnapshot({
        permission: info.permission,
        origin: source?.origin ?? "unknown",
        patterns: info.patterns,
        metadata: info.metadata,
        action: source?.action ?? {
          identity: info.permission,
          arguments: source?.arguments,
          complete: false,
        },
        trusted: turn.trusted,
        untrusted: turn.untrusted,
        trustedComplete: turn.trustedComplete,
        untrustedComplete: turn.untrustedComplete,
        contextSafeForGate: turn.contextSafeForGate,
      })
      const review: PermissionReviewContext = {
        policyVersion: PERMISSION_REVIEW_POLICY_VERSION,
        reviewID: `review_${id}`,
        origin: source?.origin ?? "unknown",
        project: current.project,
        session: sessionContext,
        agent: source?.agent,
        model: source?.model,
        arguments: source?.arguments === undefined ? undefined : safeReviewValue(source.arguments),
        snapshot,
        rules,
      }

      const hookInput: PermissionReviewInput = {
        ...info,
        patterns: [...info.patterns],
        always: [...info.always],
        metadata: info.metadata,
        review,
      }
      const prepared = yield* plugin.preparePermissionAsk(hookInput)
      const permissionConfig = yield* config.get()
      const reviewerConfig = permissionConfig.permission_reviewer
      const evaluatorConfig = permissionConfig.bash_permission_evaluator
      const started = yield* Clock.currentTimeMillis
      const deadline = started + 30_000
      let result: Exclude<ReviewResult, "interrupted">
      let correctionFeedback: string | undefined
      const reserve = () => {
        if (current.reviews.size >= REVIEW_CAPACITY) return
        const lease: ReviewLease = { settled: false, completed: false }
        current.reviews.add(lease)
        return lease
      }
      const finish = (lease: ReviewLease) => {
        lease.completed = true
        if (lease.settled) current.reviews.delete(lease)
      }
      const settle = (lease: ReviewLease) => {
        lease.settled = true
        if (lease.completed) current.reviews.delete(lease)
      }

      const pluginLease = prepared ? reserve() : undefined
      const pluginRun = pluginLease ? prepared?.() : undefined
      if (pluginLease && pluginRun) {
        void pluginRun.settled.then(
          () => settle(pluginLease),
          () => settle(pluginLease),
        )
      }
      const pluginWait = pluginRun
        ? Effect.gen(function* () {
            const timeoutMs = Math.max(0, deadline - (yield* Clock.currentTimeMillis))
            if (timeoutMs === 0) return "timeout" as const
            return yield* Effect.promise(() => pluginRun.result).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                return Effect.succeed("error" as const)
              }),
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () => Effect.succeed("timeout" as const),
              }),
            )
          }).pipe(Effect.ensuring(Effect.sync(() => finish(pluginLease!))))
        : Effect.succeed(prepared ? ("capacity" as const) : undefined)

      const prepareReviewer = (timeoutMs: number) =>
        Effect.uninterruptible(
          reviewer
            .prepareAssessment({
              config: reviewerConfig!,
              permission: info.permission,
              origin: review.origin,
              snapshot,
              timeoutMs,
            })
            .pipe(
              Effect.tap((run) => {
                if (!run.admitted) return Effect.void
                const active: ActiveReviewerRun = { run }
                current.reviewerRuns.add(active)
                return run.settled.pipe(
                  Effect.flatMap(() =>
                    current.disposed
                      ? Effect.void
                      : Effect.logInfo("permission review settled", {
                          source: "builtin",
                          reviewSettled: true,
                        }),
                  ),
                  Effect.ensuring(Effect.sync(() => current.reviewerRuns.delete(active))),
                  Effect.forkIn(current.scope),
                  Effect.asVoid,
                )
              }),
            ),
        ).pipe(Effect.provideService(InstanceRef, instance))
      const waitReviewer = (timeoutMs: number) =>
        prepareReviewer(timeoutMs).pipe(
          Effect.flatMap((run) =>
            run.result.pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                return Effect.succeed({ failure: "provider" as const })
              }),
              Effect.map((reviewResult) => ({ run, reviewResult })),
            ),
          ),
        )

      const evaluatorApplicable = info.permission === "bash" || source?.action?.identity === "bash"
      const waitEvaluator =
        evaluatorApplicable && evaluatorConfig && evaluatorConfig.mode !== "disabled"
          ? Effect.uninterruptible(bashEvaluator.prepare({ config: evaluatorConfig, action: source?.action })).pipe(
              Effect.tap((run) => {
                if (!run.admitted) return Effect.void
                const active: ActiveReviewerRun = { run }
                current.reviewerRuns.add(active)
                return run.settled.pipe(
                  Effect.ensuring(Effect.sync(() => current.reviewerRuns.delete(active))),
                  Effect.forkIn(current.scope),
                  Effect.asVoid,
                )
              }),
              Effect.flatMap((run) => run.result.pipe(Effect.map((reviewResult) => ({ run, reviewResult })))),
              Effect.catchCause((cause) => {
                if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                return Effect.succeed({ run: undefined, reviewResult: { failure: "process" as const } })
              }),
            )
          : undefined

      if (evaluatorConfig?.mode === "audit-only" && waitEvaluator) {
        yield* waitEvaluator.pipe(
          Effect.flatMap(({ reviewResult }) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                auditEvaluator({
                  info,
                  review,
                  result: "decision" in reviewResult ? reviewResult.decision : reviewResult.failure,
                  latencyMs: now - started,
                  authoritative: false,
                }),
              ),
            ),
          ),
          Effect.catchCause((cause) =>
            current.disposed
              ? Effect.void
              : Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    auditEvaluator({
                      info,
                      review,
                      result: Cause.hasInterrupts(cause) ? "interrupted" : "process",
                      latencyMs: now - started,
                      authoritative: false,
                    }),
                  ),
                ),
          ),
          Effect.forkIn(current.scope),
        )
      }

      const evaluator =
        (evaluatorConfig?.mode === "enforce" || evaluatorConfig?.mode === "permit-only") && waitEvaluator
          ? yield* waitEvaluator.pipe(
              Effect.tap(({ run, reviewResult }) =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    auditEvaluator({
                      info,
                      review,
                      result: "decision" in reviewResult ? reviewResult.decision : reviewResult.failure,
                      latencyMs: now - started,
                      authoritative:
                        evaluatorConfig.mode === "enforce" ||
                        (run?.isSettled() === true &&
                          "decision" in reviewResult &&
                          (reviewResult.decision === "allow" || reviewResult.decision === "deny")),
                    }),
                  ),
                ),
              ),
            )
          : undefined
      const evaluatorResult = evaluator?.reviewResult
      const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis))

      const evaluatorEnforcing = evaluatorApplicable && evaluatorConfig?.mode === "enforce"
      const evaluatorPermitOnly = evaluatorApplicable && evaluatorConfig?.mode === "permit-only"
      const evaluatorDecision = evaluatorResult && "decision" in evaluatorResult ? evaluatorResult.decision : undefined
      const evaluatorPermitDecision = evaluator?.run?.isSettled() ? evaluatorDecision : undefined
      const needsReviewer =
        (!evaluatorEnforcing && !evaluatorPermitOnly) ||
        (evaluatorEnforcing && evaluatorDecision === "noop") ||
        (evaluatorPermitOnly && evaluatorPermitDecision !== "allow" && evaluatorPermitDecision !== "deny")
      if (reviewerConfig?.mode === "audit-only" && needsReviewer && remaining > 0) {
        yield* waitReviewer(remaining).pipe(
          Effect.flatMap(({ run, reviewResult }) =>
            Effect.gen(function* () {
              if (current.disposed) return
              const latencyMs = (yield* Clock.currentTimeMillis) - started
              yield* audit({
                info,
                review,
                source: "builtin",
                result: "assessment" in reviewResult ? reviewResult.assessment.outcome : reviewResult.failure,
                latencyMs,
                fallbackToHuman: false,
                reviewSettled: run.isSettled(),
                policy: reviewerConfig.policy ?? "conservative-v1",
                assessment: "assessment" in reviewResult ? reviewResult.assessment : undefined,
                dispositionAuthority: "observational",
              })
            }),
          ),
          Effect.catchCause((cause) =>
            current.disposed
              ? Effect.void
              : Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    audit({
                      info,
                      review,
                      source: "builtin",
                      result: Cause.hasInterrupts(cause) ? "interrupted" : "provider",
                      latencyMs: now - started,
                      fallbackToHuman: false,
                      reviewSettled: false,
                      policy: reviewerConfig.policy ?? "conservative-v1",
                      dispositionAuthority: "observational",
                    }),
                  ),
                ),
          ),
          Effect.forkIn(current.scope),
        )
      }

      const reviewerWait: Effect.Effect<
        { run: PermissionReviewer.AssessmentRun; reviewResult: BuiltinResult } | undefined
      > =
        reviewerConfig?.mode === "enforce" && needsReviewer && remaining > 0
          ? waitReviewer(remaining)
          : Effect.succeed(undefined)
      const [pluginResult, builtin] = yield* Effect.all([pluginWait, reviewerWait] as const, {
        concurrency: "unbounded",
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const latencyMs = (yield* Clock.currentTimeMillis) - started
            if (prepared) {
              yield* audit({
                info,
                review,
                source: "plugin",
                result: "interrupted",
                latencyMs,
                fallbackToHuman: false,
                reviewSettled: pluginLease?.settled ?? true,
                dispositionAuthority: "human",
              })
            }
          }),
        ),
      )
      const builtinResult = builtin?.reviewResult
      const pluginPermits = pluginResult === undefined || pluginResult === "allow"
      const evaluatorPermits = !evaluatorEnforcing || evaluatorDecision === "allow" || evaluatorDecision === "noop"
      const otherSourcesPermit = pluginPermits && evaluatorPermits
      const riskPolicy = reviewerConfig?.policy ?? "conservative-v1"
      const automaticRiskConfig =
        reviewerConfig?.mode === "enforce" &&
        (riskPolicy === "obvious-risk-only-v1" || riskPolicy === "exceptional-risk-only-v1")
      const riskPolicyAssessment =
        builtinResult && "assessment" in builtinResult && "reason_code" in builtinResult.assessment
          ? builtinResult.assessment
          : undefined
      const bashRiskCandidate =
        automaticRiskConfig &&
        riskPolicyAssessment !== undefined &&
        PermissionReviewer.isObviousRiskCandidate({
          settled: builtin?.run.isSettled() ?? false,
          permission: info.permission,
          assessment: riskPolicyAssessment,
          snapshot,
          policy: riskPolicy,
        })
      const genericRiskAllowCandidate =
        automaticRiskConfig &&
        riskPolicyAssessment !== undefined &&
        PermissionReviewer.isGenericRiskAllowCandidate({
          settled: builtin?.run.isSettled() ?? false,
          permission: info.permission,
          assessment: riskPolicyAssessment,
          snapshot,
          policy: riskPolicy,
        })

      if (pluginResult === "deny") result = "deny"
      else if (
        (evaluatorEnforcing && evaluatorDecision === "deny") ||
        (evaluatorPermitOnly && evaluatorPermitDecision === "deny")
      )
        result = "deny"
      else if (pluginResult === "ask") result = "ask"
      else if (evaluatorEnforcing && !evaluatorPermits) result = "ask"
      else if (builtinResult && "failure" in builtinResult) result = "ask"
      else if (riskPolicyAssessment) {
        if (
          riskPolicyAssessment.outcome === "allow" &&
          reviewerConfig?.automatic_allow === "policy-gated" &&
          (bashRiskCandidate || genericRiskAllowCandidate) &&
          otherSourcesPermit
        ) {
          result = "allow"
        } else if (
          riskPolicyAssessment.outcome === "rewrite" &&
          reviewerConfig?.automatic_rewrite === "once-per-turn" &&
          bashRiskCandidate &&
          otherSourcesPermit &&
          turn.rootSessionID === info.sessionID &&
          turn.directPromptAdmission &&
          turn.turnID.length > 0 &&
          turn.rewrite.status === "available"
        ) {
          correctionFeedback = PermissionReviewer.obviousRiskRewriteFeedback(riskPolicyAssessment.safer_alternative)
          result = correctionFeedback ? "rewrite" : "ask"
        } else result = "ask"
      } else if (builtinResult && "assessment" in builtinResult) {
        result = builtinResult.assessment.outcome === "deny" ? "deny" : "ask"
      } else if (
        ((evaluatorEnforcing && evaluatorDecision === "allow") ||
          (evaluatorPermitOnly && evaluatorPermitDecision === "allow")) &&
        pluginPermits
      )
        result = "allow"
      else if (
        reviewerConfig?.mode !== "enforce" &&
        !evaluatorEnforcing &&
        !evaluatorPermitOnly &&
        pluginResult === "allow"
      )
        result = "allow"
      else result = "ask"

      const latencyMs = (yield* Clock.currentTimeMillis) - started
      if (pluginResult === "error") {
        yield* Effect.logError("permission ask plugin failed or returned invalid status")
      }
      if (pluginResult) {
        yield* audit({
          info,
          review,
          source: "plugin",
          result: pluginResult,
          latencyMs,
          fallbackToHuman: pluginResult !== "allow" && pluginResult !== "deny",
          reviewSettled: pluginLease?.settled ?? true,
          dispositionAuthority: result === "deny" ? "deny" : result === "allow" ? "plugin" : "human",
        })
      }
      if (builtinResult && result !== "rewrite") {
        yield* audit({
          info,
          review,
          source: "builtin",
          result: "assessment" in builtinResult ? builtinResult.assessment.outcome : builtinResult.failure,
          latencyMs,
          fallbackToHuman: result === "ask",
          reviewSettled: builtin?.run.isSettled() ?? true,
          policy: reviewerConfig?.policy ?? "conservative-v1",
          assessment: "assessment" in builtinResult ? builtinResult.assessment : undefined,
          dispositionAuthority: result === "allow" ? "automatic_allow" : result === "deny" ? "deny" : "human",
        })
      }

      if (result === "allow") return
      if (result === "rewrite" && correctionFeedback) {
        const token = yield* Effect.sync(() => {
          const active = current.turns.get(info.sessionID)
          if (active?.turnID !== turn.turnID || !active.directPromptAdmission || active.rewrite.status !== "available")
            return undefined
          const token = ++rewriteClaim
          active.rewrite = { status: "claimed", token }
          return token
        })
        if (token !== undefined) {
          yield* Effect.gen(function* () {
            if (builtinResult) {
              yield* audit({
                info,
                review,
                source: "builtin",
                result: "assessment" in builtinResult ? builtinResult.assessment.outcome : builtinResult.failure,
                latencyMs,
                fallbackToHuman: false,
                reviewSettled: builtin?.run.isSettled() ?? true,
                policy: reviewerConfig?.policy ?? "conservative-v1",
                assessment: "assessment" in builtinResult ? builtinResult.assessment : undefined,
                dispositionAuthority: "automatic_rewrite",
              })
            }
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const claimed = yield* Effect.sync(() => {
                  const active = current.turns.get(info.sessionID)
                  if (
                    active?.turnID !== turn.turnID ||
                    !active.directPromptAdmission ||
                    active.rewrite.status !== "claimed" ||
                    active.rewrite.token !== token
                  )
                    return false
                  active.rewrite = { status: "persisting", token }
                  return true
                })
                if (!claimed) return false
                const persisted = yield* persistCorrection({ sessionID: info.sessionID, turnID: turn.turnID }).pipe(
                  Effect.exit,
                )
                yield* Effect.sync(() => {
                  const active = current.turns.get(info.sessionID)
                  if (
                    active?.turnID === turn.turnID &&
                    active.rewrite.status === "persisting" &&
                    active.rewrite.token === token
                  )
                    active.rewrite = { status: "used" }
                })
                if (Exit.isFailure(persisted) || persisted.value !== "inserted") return false
                return yield* new PermissionV1.PolicyCorrectionError({ feedback: correctionFeedback })
              }),
            )
          }).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                const active = current.turns.get(info.sessionID)
                if (active?.turnID !== turn.turnID) return
                if (active.rewrite.status === "claimed" && active.rewrite.token === token)
                  active.rewrite = { status: "available" }
                if (active.rewrite.status === "persisting" && active.rewrite.token === token)
                  active.rewrite = { status: "used" }
              }),
            ),
          )
        }
        result = "ask"
        if (builtinResult) {
          yield* audit({
            info,
            review,
            source: "builtin",
            result: "assessment" in builtinResult ? builtinResult.assessment.outcome : builtinResult.failure,
            latencyMs,
            fallbackToHuman: true,
            reviewSettled: builtin?.run.isSettled() ?? true,
            policy: reviewerConfig?.policy ?? "conservative-v1",
            assessment: "assessment" in builtinResult ? builtinResult.assessment : undefined,
            dispositionAuthority: "human",
          })
        }
      }
      if (result === "deny") {
        return yield* new PermissionV1.DeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
        })
      }

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      const auditCorrelationKey = correlation(info, review.origin)
      yield* Effect.logInfo("asking", {
        permission: info.permission,
        origin: review.origin,
        ...(auditCorrelationKey ? { auditCorrelationKey } : {}),
        patternCount: info.patterns.length,
      })
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => pending.set(id, { info, deferred })),
        () => events.publish(Event.Asked, info).pipe(Effect.andThen(Deferred.await(deferred))),
        () => Effect.sync(() => pending.delete(id)),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const notifications = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const { approved, pending } = yield* InstanceState.get(state)
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

          const result: Array<{
            sessionID: PermissionV1.Request["sessionID"]
            requestID: PermissionV1.ID
            reply: PermissionV1.Reply
          }> = [{ sessionID: existing.info.sessionID, requestID: existing.info.id, reply: input.reply }]
          pending.delete(input.requestID)

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message
                ? new PermissionV1.CorrectedError({ feedback: input.message })
                : new PermissionV1.RejectedError(),
            )
            for (const [id, item] of pending.entries()) {
              if (item.info.sessionID !== existing.info.sessionID) continue
              pending.delete(id)
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
              result.push({ sessionID: item.info.sessionID, requestID: item.info.id, reply: "reject" })
            }
            return result
          }

          yield* Deferred.succeed(existing.deferred, undefined)
          if (input.reply === "once") return result

          for (const pattern of existing.info.always) {
            approved.push({ permission: existing.info.permission, pattern, action: "allow" })
          }
          for (const [id, item] of pending.entries()) {
            if (item.info.sessionID !== existing.info.sessionID) continue
            const ok = item.info.patterns.every(
              (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
            )
            if (!ok) continue
            pending.delete(id)
            yield* Deferred.succeed(item.deferred, undefined)
            result.push({ sessionID: item.info.sessionID, requestID: item.info.id, reply: "always" })
          }
          return result
        }),
      )

      yield* Effect.forEach(notifications, (notification) => events.publish(Event.Replied, notification), {
        discard: true,
      })
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list, captureTurn, captureUntrusted })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    EventV2Bridge.node,
    Plugin.node,
    Session.node,
    Config.node,
    PermissionReviewer.node,
    BashPermissionEvaluator.node,
    Database.node,
  ],
})

export * as Permission from "."
