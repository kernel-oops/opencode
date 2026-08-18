import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Cause, Clock, Deferred, Effect, Layer, Context, Exit, Scope } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import {
  PERMISSION_REVIEW_POLICY_VERSION,
  type PermissionReviewContext,
  type PermissionReviewInput,
} from "@opencode-ai/plugin"
import { safeReviewValue } from "./review"
import { PermissionReviewer } from "./reviewer"
import { InstanceRef } from "@/effect/instance-ref"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
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
  readonly run: PermissionReviewer.Run
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  reviews: Set<ReviewLease>
  reviewerRuns: Set<ActiveReviewerRun>
  scope: Scope.Scope
  disposed: boolean
  project: PermissionReviewContext["project"]
}

export const REVIEW_TIMEOUT = "30 seconds"
export const REVIEW_CAPACITY = 4

type ReviewResult =
  | "allow"
  | "ask"
  | "deny"
  | "timeout"
  | "error"
  | "capacity"
  | "interrupted"
  | PermissionReviewer.Failure

type BuiltinResult = PermissionReviewer.Result

function safeReviewString(value: string) {
  const result = safeReviewValue(value)
  return typeof result === "string" ? result : "[UNREADABLE]"
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
          }),
        )

        return state
      }),
    )

    const lineage = Effect.fn("Permission.lineage")(function* (sessionID: PermissionV1.Request["sessionID"]) {
      const fallback = {
        lineage: [sessionID],
        complete: false,
        reason: "missing_current" as const,
      }
      const first = yield* sessions.get(sessionID).pipe(Effect.exit)
      if (Exit.isFailure(first)) {
        yield* Effect.logWarning("permission review session context unavailable", { sessionID })
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
    }) {
      yield* Effect.logInfo("permission review", {
        requestID: input.info.id,
        reviewID: input.review.reviewID,
        sessionID: input.info.sessionID,
        parentSessionID: input.review.session.parentID,
        rootSessionID: input.review.session.rootID,
        projectID: input.review.project.id,
        messageID: input.info.tool?.messageID,
        callID: input.info.tool?.callID,
        providerID: input.review.model?.providerID,
        modelID: input.review.model?.modelID,
        permission: input.info.permission,
        origin: input.review.origin,
        source: input.source,
        result: input.result,
        latencyMs: input.latencyMs,
        policyVersion: input.review.policyVersion,
        fallbackToHuman: input.fallbackToHuman,
        reviewSettled: input.reviewSettled,
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
        : yield* lineage(info.sessionID)
      const review: PermissionReviewContext = {
        policyVersion: PERMISSION_REVIEW_POLICY_VERSION,
        reviewID: `review_${id}`,
        origin: source?.origin ?? "unknown",
        project: current.project,
        session: sessionContext,
        agent: source?.agent,
        model: source?.model,
        arguments: source?.arguments === undefined ? undefined : safeReviewValue(source.arguments),
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
      const reviewerConfig = (yield* config.get()).permission_reviewer
      const started = yield* Clock.currentTimeMillis
      let result: Exclude<ReviewResult, "interrupted">
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
        ? Effect.promise(() => pluginRun.result).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
              return Effect.succeed("error" as const)
            }),
            Effect.timeoutOrElse({
              duration: REVIEW_TIMEOUT,
              orElse: () => Effect.succeed("timeout" as const),
            }),
            Effect.ensuring(Effect.sync(() => finish(pluginLease!))),
          )
        : Effect.succeed(prepared ? ("capacity" as const) : undefined)

      const prepareReviewer = Effect.uninterruptible(
        reviewer
          .prepare({
            config: reviewerConfig!,
            permission: info.permission,
            origin: review.origin,
            arguments: source?.arguments,
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
                        requestID: info.id,
                        reviewID: review.reviewID,
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
      const waitReviewer = prepareReviewer.pipe(
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

      if (reviewerConfig?.mode === "audit-only") {
        const authoritative = yield* Deferred.make<void>()
        yield* Deferred.await(authoritative).pipe(
          Effect.andThen(waitReviewer),
          Effect.flatMap(({ run, reviewResult }) =>
            Effect.gen(function* () {
              if (current.disposed) return
              const latencyMs = (yield* Clock.currentTimeMillis) - started
              yield* audit({
                info,
                review,
                source: "builtin",
                result: "decision" in reviewResult ? reviewResult.decision : reviewResult.failure,
                latencyMs,
                fallbackToHuman: false,
                reviewSettled: run.isSettled(),
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
                    }),
                  ),
                ),
          ),
          Effect.forkIn(current.scope),
        )

        const pluginResult = yield* pluginWait.pipe(
          Effect.onInterrupt(() =>
            prepared
              ? Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    audit({
                      info,
                      review,
                      source: "plugin",
                      result: "interrupted",
                      latencyMs: now - started,
                      fallbackToHuman: false,
                      reviewSettled: pluginLease?.settled ?? true,
                    }),
                  ),
                )
              : Effect.void,
          ),
        )
        // The detached built-in work cannot start until the authoritative disposition is known.
        yield* Deferred.succeed(authoritative, undefined)
        const latencyMs = (yield* Clock.currentTimeMillis) - started
        if (pluginResult === "error") {
          yield* Effect.logError("permission ask plugin failed or returned invalid status", {
            requestID: info.id,
            reviewID: review.reviewID,
          })
        }
        yield* audit({
          info,
          review,
          source: "plugin",
          result: pluginResult ?? "ask",
          latencyMs,
          fallbackToHuman:
            pluginResult === undefined ||
            pluginResult === "ask" ||
            pluginResult === "timeout" ||
            pluginResult === "error" ||
            pluginResult === "capacity",
          reviewSettled: pluginLease?.settled ?? true,
        })
        result = pluginResult ?? "ask"
      } else {
        const reviewerWait: Effect.Effect<{ run: PermissionReviewer.Run; reviewResult: BuiltinResult } | undefined> =
          reviewerConfig ? waitReviewer : Effect.succeed(undefined)
        const completed = yield* Effect.all([pluginWait, reviewerWait] as const, { concurrency: "unbounded" }).pipe(
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
                })
              }
            }),
          ),
        )
        const [pluginResult, builtin] = completed
        const builtinResult = builtin?.reviewResult
        const latencyMs = (yield* Clock.currentTimeMillis) - started
        if (pluginResult === "error") {
          yield* Effect.logError("permission ask plugin failed or returned invalid status", {
            requestID: info.id,
            reviewID: review.reviewID,
          })
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
          })
        }
        if (builtinResult) {
          yield* audit({
            info,
            review,
            source: "builtin",
            result: "decision" in builtinResult ? builtinResult.decision : builtinResult.failure,
            latencyMs,
            fallbackToHuman: !("decision" in builtinResult) || builtinResult.decision === "ask",
            reviewSettled: builtin?.run.isSettled() ?? true,
          })
        }

        const enforcing = [
          ...(pluginResult ? [pluginResult] : []),
          ...(builtinResult ? ["decision" in builtinResult ? builtinResult.decision : "ask"] : []),
        ]
        if (enforcing.includes("deny")) result = "deny"
        else if (enforcing.length > 0 && enforcing.every((item) => item === "allow")) result = "allow"
        else result = "ask"
      }

      if (result === "allow") return
      if (result === "deny") {
        return yield* new PermissionV1.DeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
        })
      }

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      yield* Effect.logInfo("asking", {
        id,
        permission: info.permission,
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

    return Service.of({ ask, reply, list })
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
  deps: [EventV2Bridge.node, Plugin.node, Session.node, Config.node, PermissionReviewer.node],
})

export * as Permission from "."
