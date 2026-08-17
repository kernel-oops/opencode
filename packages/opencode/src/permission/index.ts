import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Cause, Clock, Deferred, Effect, Layer, Context, Exit } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import {
  PERMISSION_REVIEW_POLICY_VERSION,
  type PermissionReviewContext,
  type PermissionReviewInput,
} from "@opencode-ai/plugin"
import { safeReviewValue } from "./review"

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
  result: Promise<Plugin.PermissionAskResult>
  settlement: Promise<void>
  settled: boolean
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  reviews: Set<ReviewLease>
  project: PermissionReviewContext["project"]
}

export const REVIEW_TIMEOUT = "30 seconds"
export const REVIEW_CAPACITY = 4

type ReviewResult = "allow" | "ask" | "deny" | "timeout" | "error" | "capacity" | "interrupted"

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
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          reviews: new Set<ReviewLease>(),
          project: {
            id: ctx.project.id,
            directory: ctx.directory,
            worktree: ctx.worktree,
          },
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
            state.reviews.clear()
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
        result: input.result,
        latencyMs: input.latencyMs,
        policyVersion: input.review.policyVersion,
        fallbackToHuman: input.fallbackToHuman,
        reviewSettled: input.reviewSettled,
      })
    })

    const ask: Interface["ask"] = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const current = yield* InstanceState.get(state)
      const { approved, pending } = current
      const { ruleset, review: source, ...request } = input
      let needsAsk = false
      const rules: PermissionReviewContext["rules"] = []

      for (const pattern of request.patterns) {
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
          pattern: reviewedPattern,
          action: reviewedRule,
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
      const started = yield* Clock.currentTimeMillis
      let result: Exclude<ReviewResult, "interrupted">
      if (!prepared) {
        result = "ask"
        yield* audit({ info, review, result, latencyMs: 0, fallbackToHuman: true, reviewSettled: true })
      } else {
        const lease = yield* Effect.sync(() => {
          if (current.reviews.size >= REVIEW_CAPACITY) return undefined
          const run = prepared()
          const item: ReviewLease = { result: run.result, settlement: run.settled, settled: false }
          current.reviews.add(item)
          void item.settlement.then(
            () => {
              item.settled = true
              current.reviews.delete(item)
            },
            () => {
              item.settled = true
              current.reviews.delete(item)
            },
          )
          return item
        })

        if (!lease) {
          result = "capacity"
          yield* audit({ info, review, result, latencyMs: 0, fallbackToHuman: true, reviewSettled: true })
        } else {
          const completed = yield* Effect.promise(() => lease.result).pipe(
            Effect.timeoutOrElse({ duration: REVIEW_TIMEOUT, orElse: () => Effect.succeed("timeout" as const) }),
            Effect.catchCause((cause) => {
              if (Cause.hasInterrupts(cause)) return Effect.failCause(cause)
              return Effect.succeed("error" as const)
            }),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                const latencyMs = (yield* Clock.currentTimeMillis) - started
                yield* audit({
                  info,
                  review,
                  result: "interrupted",
                  latencyMs,
                  fallbackToHuman: false,
                  reviewSettled: lease.settled,
                })
              }),
            ),
          )
          result = completed
          const latencyMs = (yield* Clock.currentTimeMillis) - started
          if (result === "error") {
            yield* Effect.logError("permission ask plugin failed or returned invalid status", {
              requestID: info.id,
              reviewID: review.reviewID,
            })
          }
          yield* audit({
            info,
            review,
            result,
            latencyMs,
            fallbackToHuman: result === "ask" || result === "timeout" || result === "error",
            reviewSettled: lease.settled,
          })
        }
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
        patterns: info.patterns.map(safeReviewString),
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
  deps: [EventV2Bridge.node, Plugin.node, Session.node],
})

export * as Permission from "."
