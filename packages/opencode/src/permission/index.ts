import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPermissionReviewerV1 } from "@opencode-ai/core/v1/config/permission-reviewer"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Cause, Clock, Deferred, Effect, Layer, Context, Exit, Option, Scope } from "effect"
import { randomUUID } from "crypto"
import { realpath, stat } from "node:fs/promises"
import { and, eq } from "drizzle-orm"
import os from "os"
import path from "node:path"
import { types } from "node:util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import {
  MessageTable,
  PartTable,
  PermissionReviewCorrectionTable,
  PermissionReviewDelegationTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Config } from "@/config/config"
import {
  PERMISSION_REVIEW_POLICY_VERSION,
  type PermissionReviewContext,
  type PermissionReviewInput,
  type PermissionReviewSnapshot,
} from "@opencode-ai/plugin"
import { BashPermissionEvaluator } from "./bash-evaluator"
import { safeReviewValue } from "./review"
import { PermissionReviewer } from "./reviewer"
import { InstanceRef } from "@/effect/instance-ref"
import { buildPermissionReviewSnapshot, validPermissionReviewAdmission, type EvidenceInput } from "./reviewer-input"
import { auditCorrelationKey } from "./audit-correlation"
import { exactSearchIncludeTarget } from "@/util/exact-search-include"
import { trustedCanonicalAlias } from "@/util/trusted-path-alias"

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
    trustedComplete?: boolean
    untrustedComplete?: boolean
    contextSafeForGate?: boolean
  }) => Effect.Effect<void>
  readonly captureUntrusted: (input: {
    sessionID: string
    turnID: string
    evidence: readonly EvidenceInput[]
  }) => Effect.Effect<void>
  readonly authoriseTaskDelegation: (input: {
    sessionID: string
    messageID: string
    callID: string
    childAgent: string
  }) => Effect.Effect<string | undefined>
  readonly captureTaskDelegation: (input: {
    receipt: string
    childSessionID: string
    childTurnID: string
  }) => Effect.Effect<void, unknown>
  readonly canResumeTask: (input: {
    parentSessionID: string
    childSessionID: string
    childAgent: string
  }) => Effect.Effect<boolean, unknown>
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

interface TurnState {
  trusted: EvidenceInput[]
  untrusted: EvidenceInput[]
  rootSessionID: string
  rootTurnID: string
  turnID: string
  directPromptAdmission: boolean
  delegatedPromptAdmission: boolean
  rewrite: RewriteState
  trustedComplete: boolean
  untrustedComplete: boolean
  contextSafeForGate: boolean
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
  turns: Map<string, TurnState>
  activeTurns: Map<string, string>
  taskReceipts: Map<
    string,
    {
      parentSessionID: string
      parentTurnID: string
      taskMessageID: string
      taskPartID: string
      taskCallID: string
      childAgent: string
    }
  >
  readScopes: Map<
    string,
    Array<{
      rootSessionID: string
      rootTurnID: string
      directory: string
      device: string
      inode: string
    }>
  >
}

const MAX_EVIDENCE_ITEMS = 64
const MAX_EVIDENCE_BYTES = 8 * 1024
const MAX_TRUSTED_EVIDENCE_BYTES = 40 * 1024
const MAX_EVIDENCE_SESSIONS = 64
const MAX_READ_SCOPE_ROOTS = 8
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

export function inspectThenRevalidateAuthority<A, E1, R1, E2, R2>(
  revalidate: () => Effect.Effect<boolean, E1, R1>,
  inspect: () => Effect.Effect<A, E2, R2>,
) {
  return Effect.gen(function* () {
    if (!(yield* revalidate())) return { authorityCurrent: false, inspection: undefined } as const
    const inspection = yield* inspect()
    return { authorityCurrent: yield* revalidate(), inspection } as const
  })
}

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
          activeTurns: new Map(),
          taskReceipts: new Map(),
          readScopes: new Map(),
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
            state.activeTurns.clear()
            state.taskReceipts.clear()
            state.readScopes.clear()
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

    const turnKey = (sessionID: string, turnID: string) => `${sessionID}\u0000${turnID}`

    const plainRecord = (value: unknown): value is Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) return false
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return false
      return Object.values(Object.getOwnPropertyDescriptors(value)).every((item) => "value" in item)
    }

    const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
      const actual = Reflect.ownKeys(value)
      const expected = [...keys].toSorted()
      return (
        actual.length === expected.length &&
        actual.every((item): item is string => typeof item === "string") &&
        actual.toSorted().every((item, index) => item === expected[index])
      )
    }

    const contains = (root: string, target: string) => {
      const relative = path.relative(root, target)
      return (
        relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
      )
    }

    const hasParentSegment = (value: string) => value.split(/[\\/]/u).includes("..")

    const canonicalPath = Effect.fn("Permission.canonicalPath")(function* (value: string) {
      return yield* Effect.tryPromise(() => realpath(value)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    })

    const pathInfo = Effect.fn("Permission.pathInfo")(function* (value: string) {
      return yield* Effect.tryPromise(() => stat(value)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    })

    const pathIdentity = Effect.fn("Permission.pathIdentity")(function* (value: string) {
      return yield* Effect.tryPromise(() => stat(value, { bigint: true })).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
    })

    type ReadScopeRequest = {
      rootSessionID: string
      rootTurnID: string
      identity: "glob" | "grep" | "read"
      kind: "file" | "directory"
      boundRead: boolean
      canonicalTarget: string
      canonicalRoot: string
      device: string
      inode: string
    }

    const readScopeAuthority = (turn: TurnState) =>
      turn.contextSafeForGate &&
      turn.trustedComplete &&
      turn.trusted.length > 0 &&
      turn.trusted.every((item) => item.source === "human") &&
      turn.rootSessionID.length > 0 &&
      turn.rootTurnID.length > 0 &&
      (turn.directPromptAdmission || turn.delegatedPromptAdmission)

    const readonlyTarget = (
      action: PermissionReviewSnapshot["action"],
      directory: string,
    ): { identity: "glob" | "grep" | "read"; raw: string; exactIncluded?: string } | undefined => {
      const registered = PermissionReviewer.registeredReadonlyInvocation(action)
      if (!registered) return
      const raw =
        registered.identity === "read" ? registered.invocation.filePath : (registered.invocation.path ?? directory)
      if (typeof raw !== "string" || raw.length === 0 || hasParentSegment(raw)) return
      const exactIncluded =
        registered.identity === "grep" ? exactSearchIncludeTarget(registered.invocation, directory) : undefined
      return { identity: registered.identity, raw, exactIncluded }
    }

    const inspectExternalReadScope = Effect.fn("Permission.inspectExternalReadScope")(function* (input: {
      info: PermissionV1.Request
      snapshot: PermissionReviewSnapshot
      turn: TurnState
      directory: string
    }) {
      if (
        process.platform !== "linux" ||
        input.info.permission !== "external_directory" ||
        input.snapshot.action.permission !== "external_directory" ||
        input.snapshot.action.origin !== "tool" ||
        !input.snapshot.action.complete ||
        input.snapshot.action.omitted_items !== 0 ||
        input.snapshot.action.omitted_bytes !== 0 ||
        !readScopeAuthority(input.turn)
      )
        return
      const target = readonlyTarget(input.snapshot.action, input.directory)
      if (!target) return
      const metadata = input.info.metadata
      if (!plainRecord(metadata)) return
      const metadataKeys =
        target.identity === "read"
          ? ["filepath", "parentDir", "readBinding", "readScope", "tool"]
          : ["filepath", "parentDir", "readScope", "searchBinding", "tool"]
      if (!exactKeys(metadata, metadataKeys)) return
      if (metadata.tool !== target.identity || !plainRecord(metadata.readScope)) return
      const readBinding = metadata.readBinding
      const boundRead =
        target.identity === "read" &&
        plainRecord(readBinding) &&
        exactKeys(readBinding, ["bindingId", "contract", "version"]) &&
        readBinding.version === 1 &&
        readBinding.contract === "pinned-external-text-v1" &&
        typeof readBinding.bindingId === "string" &&
        /^[0-9a-f]{32}$/u.test(readBinding.bindingId)
      if (target.identity === "read" && !boundRead) return
      const searchBinding = metadata.searchBinding
      const boundSearch =
        target.identity === "grep" &&
        plainRecord(searchBinding) &&
        exactKeys(searchBinding, ["bindingId", "contract", "effects", "executor", "mode", "version"]) &&
        searchBinding.version === 1 &&
        searchBinding.contract === "pinned-external-search-v1" &&
        typeof searchBinding.bindingId === "string" &&
        /^[0-9a-f]{32}$/u.test(searchBinding.bindingId) &&
        Array.isArray(searchBinding.effects) &&
        searchBinding.effects.length === 0 &&
        searchBinding.mode === "file" &&
        searchBinding.executor === "ripgrep-inherited-readonly-fd-v1"
      if ((target.identity === "glob" || target.identity === "grep") && !boundSearch) return
      const scope = metadata.readScope
      if (
        !exactKeys(scope, [
          "canonicalRoot",
          "canonicalTarget",
          "kind",
          "rootDevice",
          "rootInode",
          "targetDevice",
          "targetInode",
          "version",
        ])
      )
        return
      if (
        scope.version !== 1 ||
        typeof scope.canonicalTarget !== "string" ||
        typeof scope.canonicalRoot !== "string" ||
        typeof scope.targetDevice !== "string" ||
        typeof scope.targetInode !== "string" ||
        typeof scope.rootDevice !== "string" ||
        typeof scope.rootInode !== "string" ||
        (scope.kind !== "file" && scope.kind !== "directory") ||
        metadata.filepath !== scope.canonicalTarget ||
        metadata.parentDir !== scope.canonicalRoot ||
        !path.isAbsolute(scope.canonicalTarget) ||
        !path.isAbsolute(scope.canonicalRoot)
      )
        return
      const lexical = path.resolve(input.directory, target.raw)
      const canonicalLexical = yield* canonicalPath(lexical)
      const canonicalIncluded = target.exactIncluded ? yield* canonicalPath(target.exactIncluded) : undefined
      const lexicalTrusted =
        canonicalLexical === scope.canonicalTarget &&
        (yield* Effect.promise(() => trustedCanonicalAlias(lexical, canonicalLexical)))
      const includedTrusted =
        target.exactIncluded !== undefined &&
        canonicalIncluded === scope.canonicalTarget &&
        (yield* Effect.promise(() => trustedCanonicalAlias(target.exactIncluded!, canonicalIncluded)))
      if (!lexicalTrusted && !includedTrusted) return
      if (!contains(scope.canonicalRoot, scope.canonicalTarget)) return
      const canonicalTarget = yield* canonicalPath(scope.canonicalTarget)
      const canonicalRoot = yield* canonicalPath(scope.canonicalRoot)
      if (canonicalTarget !== scope.canonicalTarget || canonicalRoot !== scope.canonicalRoot) return
      const targetInfo = yield* pathInfo(canonicalTarget)
      const rootInfo = yield* pathInfo(canonicalRoot)
      const targetIdentity = yield* pathIdentity(canonicalTarget)
      const rootIdentity = yield* pathIdentity(canonicalRoot)
      if (
        !targetInfo ||
        !rootInfo ||
        !targetIdentity ||
        !rootIdentity ||
        !rootInfo.isDirectory() ||
        scope.targetDevice !== String(targetIdentity.dev) ||
        scope.targetInode !== String(targetIdentity.ino) ||
        scope.rootDevice !== String(rootIdentity.dev) ||
        scope.rootInode !== String(rootIdentity.ino) ||
        (scope.kind === "directory" ? !targetInfo.isDirectory() : !targetInfo.isFile()) ||
        (target.identity === "glob" && scope.kind !== "directory") ||
        (scope.kind === "directory"
          ? canonicalRoot !== canonicalTarget
          : canonicalRoot !== path.dirname(canonicalTarget))
      )
        return
      const pattern = path.join(canonicalRoot, "*").replaceAll("\\", "/")
      if (input.info.patterns.length !== 1 || input.info.patterns[0] !== pattern) return
      const kind: ReadScopeRequest["kind"] = scope.kind
      return {
        rootSessionID: input.turn.rootSessionID,
        rootTurnID: input.turn.rootTurnID,
        identity: target.identity,
        kind,
        boundRead,
        canonicalTarget,
        canonicalRoot,
        device: String(rootIdentity.dev),
        inode: String(rootIdentity.ino),
      }
    })

    const matchingReadScopes = Effect.fn("Permission.matchingReadScopes")(function* (
      current: State,
      turn: TurnState,
      target: string,
    ) {
      if (!readScopeAuthority(turn)) return []
      const scopes = current.readScopes.get(turnKey(turn.rootSessionID, turn.rootTurnID)) ?? []
      const matches = [] as typeof scopes
      for (const scope of scopes) {
        if (!contains(scope.directory, target)) continue
        const canonical = yield* canonicalPath(scope.directory)
        const info = canonical ? yield* pathInfo(canonical) : undefined
        const identity = canonical ? yield* pathIdentity(canonical) : undefined
        if (
          canonical === scope.directory &&
          info?.isDirectory() &&
          String(identity?.dev) === scope.device &&
          String(identity?.ino) === scope.inode
        )
          matches.push(scope)
      }
      return matches
    })

    const readScopeAllowsExternalGate = Effect.fn("Permission.readScopeAllowsExternalGate")(function* (
      current: State,
      request: ReadScopeRequest | undefined,
      turn: TurnState,
    ) {
      if (!request) return false
      if (request.identity !== "read" || request.kind !== "file" || !request.boundRead) return false
      const matches = yield* matchingReadScopes(current, turn, request.canonicalTarget)
      const match = matches[0]
      return (
        matches.length === 1 &&
        match?.directory === request.canonicalRoot &&
        match.device === request.device &&
        match.inode === request.inode
      )
    })

    const readScopeAllowsPrimary = Effect.fn("Permission.readScopeAllowsPrimary")(function* (input: {
      current: State
      info: PermissionV1.Request
      snapshot: PermissionReviewSnapshot
      turn: TurnState
      directory: string
    }) {
      if (!readScopeAuthority(input.turn)) return false
      const target = readonlyTarget(input.snapshot.action, input.directory)
      if (
        !target ||
        target.identity !== "read" ||
        typeof input.snapshot.action.cwd !== "string" ||
        !path.isAbsolute(input.snapshot.action.cwd)
      )
        return false
      const metadata = input.info.metadata
      if (
        !plainRecord(metadata) ||
        !exactKeys(metadata, ["readBinding", "readScope"]) ||
        !plainRecord(metadata.readBinding) ||
        !plainRecord(metadata.readScope)
      )
        return false
      const readBinding = metadata.readBinding
      const scope = metadata.readScope
      if (
        !exactKeys(readBinding, ["bindingId", "contract", "version"]) ||
        readBinding.version !== 1 ||
        readBinding.contract !== "pinned-external-text-v1" ||
        typeof readBinding.bindingId !== "string" ||
        !/^[0-9a-f]{32}$/u.test(readBinding.bindingId) ||
        !exactKeys(scope, [
          "canonicalRoot",
          "canonicalTarget",
          "kind",
          "rootDevice",
          "rootInode",
          "targetDevice",
          "targetInode",
          "version",
        ]) ||
        scope.version !== 1 ||
        scope.kind !== "file" ||
        typeof scope.canonicalTarget !== "string" ||
        typeof scope.canonicalRoot !== "string" ||
        typeof scope.targetDevice !== "string" ||
        typeof scope.targetInode !== "string" ||
        typeof scope.rootDevice !== "string" ||
        typeof scope.rootInode !== "string"
      )
        return false
      const lexical = path.resolve(input.directory, target.raw)
      const canonicalTarget = yield* canonicalPath(lexical)
      if (!canonicalTarget) return false
      const targetInfo = yield* pathInfo(canonicalTarget)
      const targetIdentity = yield* pathIdentity(canonicalTarget)
      if (!targetInfo || !targetIdentity) return false
      if (!targetInfo.isFile()) return false
      const expectedCwd = targetInfo.isDirectory() ? canonicalTarget : path.dirname(canonicalTarget)
      const canonicalCwd = yield* canonicalPath(input.snapshot.action.cwd)
      const rootIdentity = canonicalCwd ? yield* pathIdentity(canonicalCwd) : undefined
      if (
        canonicalCwd !== expectedCwd ||
        scope.canonicalTarget !== canonicalTarget ||
        scope.canonicalRoot !== canonicalCwd ||
        scope.targetDevice !== String(targetIdentity.dev) ||
        scope.targetInode !== String(targetIdentity.ino) ||
        scope.rootDevice !== String(rootIdentity?.dev) ||
        scope.rootInode !== String(rootIdentity?.ino) ||
        !(yield* Effect.promise(() => trustedCanonicalAlias(input.snapshot.action.cwd!, canonicalCwd)))
      )
        return false
      const matches = yield* matchingReadScopes(input.current, input.turn, canonicalTarget)
      const match = matches[0]
      return (
        matches.length === 1 &&
        match?.directory === scope.canonicalRoot &&
        match.device === scope.rootDevice &&
        match.inode === scope.rootInode
      )
    })

    type ReadScopeCode =
      | "read_scope_minted"
      | "read_scope_reused"
      | "read_scope_duplicate"
      | "read_scope_ambiguous"
      | "read_scope_capacity"

    const rememberReadScope = (current: State, request: ReadScopeRequest): ReadScopeCode => {
      const key = turnKey(request.rootSessionID, request.rootTurnID)
      const scopes = current.readScopes.get(key) ?? []
      const duplicate = scopes.find((scope) => scope.directory === request.canonicalRoot)
      if (duplicate) {
        duplicate.device = request.device
        duplicate.inode = request.inode
        return "read_scope_duplicate"
      }
      if (
        scopes.some(
          (scope) =>
            contains(scope.directory, request.canonicalRoot) || contains(request.canonicalRoot, scope.directory),
        )
      )
        return "read_scope_ambiguous"
      if (scopes.length >= MAX_READ_SCOPE_ROOTS) return "read_scope_capacity"
      const next = [
        ...scopes,
        {
          rootSessionID: request.rootSessionID,
          rootTurnID: request.rootTurnID,
          directory: request.canonicalRoot,
          device: request.device,
          inode: request.inode,
        },
      ]
      remember(current.readScopes, key, next)
      return "read_scope_minted"
    }

    const auditReadScope = Effect.fn("Permission.auditReadScope")(function* (input: {
      info: PermissionV1.Request
      origin: PermissionReviewContext["origin"]
      code: ReadScopeCode
    }) {
      const auditCorrelationKey = correlation(input.info, input.origin)
      yield* Effect.logInfo("permission read scope", {
        permission: input.info.permission,
        origin: input.origin,
        ...(auditCorrelationKey ? { auditCorrelationKey } : {}),
        readScopeCode: input.code,
      })
    })

    const sameSessionScope = (
      left: Pick<typeof SessionTable.$inferSelect, "project_id" | "workspace_id" | "directory" | "path">,
      right: Pick<typeof SessionTable.$inferSelect, "project_id" | "workspace_id" | "directory" | "path">,
    ) =>
      left.project_id === right.project_id &&
      left.workspace_id === right.workspace_id &&
      left.directory === right.directory &&
      left.path === right.path

    const resolveDelegatedAuthority = Effect.fn("Permission.resolveDelegatedAuthority")(function* (input: {
      childSessionID: string
      childTurnID: string
    }) {
      const seen = new Set<string>()
      let sessionID = SessionID.make(input.childSessionID)
      let turnID = MessageID.make(input.childTurnID)
      let expectedRootSessionID: string | undefined
      let expectedRootTurnID: string | undefined

      for (let depth = 0; depth < 12; depth++) {
        const key = turnKey(sessionID, turnID)
        if (seen.has(key)) return
        seen.add(key)
        const edge = yield* db
          .select()
          .from(PermissionReviewDelegationTable)
          .where(eq(PermissionReviewDelegationTable.child_turn_id, turnID))
          .get()
        if (!edge || edge.child_session_id !== sessionID) return
        if (
          (expectedRootSessionID !== undefined && edge.root_session_id !== expectedRootSessionID) ||
          (expectedRootTurnID !== undefined && edge.root_turn_id !== expectedRootTurnID)
        )
          return
        expectedRootSessionID = edge.root_session_id
        expectedRootTurnID = edge.root_turn_id

        const child = yield* db.select().from(SessionTable).where(eq(SessionTable.id, edge.child_session_id)).get()
        const parent = yield* db.select().from(SessionTable).where(eq(SessionTable.id, edge.parent_session_id)).get()
        if (
          !child ||
          !parent ||
          child.parent_id !== parent.id ||
          !sameSessionScope(child, parent) ||
          child.agent !== edge.child_agent
        )
          return

        const childTurn = yield* db
          .select({ sessionID: MessageTable.session_id, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, edge.child_turn_id))
          .get()
        const parentTurn = yield* db
          .select({ sessionID: MessageTable.session_id, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, edge.parent_turn_id))
          .get()
        const taskMessage = yield* db
          .select({ sessionID: MessageTable.session_id, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, edge.task_message_id))
          .get()
        const taskPart = yield* db
          .select({ messageID: PartTable.message_id, sessionID: PartTable.session_id, data: PartTable.data })
          .from(PartTable)
          .where(eq(PartTable.id, edge.task_part_id))
          .get()
        const childTurnData = childTurn?.data as SessionV1.Info | undefined
        const parentTurnData = parentTurn?.data as SessionV1.Info | undefined
        const taskMessageData = taskMessage?.data as SessionV1.Info | undefined
        const taskPartData = taskPart?.data as unknown as SessionV1.Part | undefined
        if (
          !childTurn ||
          childTurn.sessionID !== child.id ||
          childTurnData?.role !== "user" ||
          childTurnData.agent !== edge.child_agent ||
          !parentTurn ||
          parentTurn.sessionID !== parent.id ||
          parentTurnData?.role !== "user" ||
          !taskMessage ||
          taskMessage.sessionID !== parent.id ||
          taskMessageData?.role !== "assistant" ||
          taskMessageData.parentID !== edge.parent_turn_id ||
          !taskPart ||
          taskPart.messageID !== edge.task_message_id ||
          taskPart.sessionID !== parent.id ||
          taskPartData?.type !== "tool" ||
          taskPartData.tool !== "task" ||
          taskPartData.callID !== edge.task_call_id
        )
          return
        const taskInput = taskPartData.state.input
        const taskMetadata = "metadata" in taskPartData.state ? taskPartData.state.metadata : undefined
        if (
          taskInput === null ||
          typeof taskInput !== "object" ||
          Array.isArray(taskInput) ||
          taskInput.subagent_type !== edge.child_agent ||
          taskMetadata?.parentSessionId !== parent.id ||
          taskMetadata.sessionId !== child.id ||
          taskMetadata.truncated === true
        )
          return

        if (parent.parent_id === null) {
          if (parent.id !== edge.root_session_id || edge.parent_turn_id !== edge.root_turn_id) return
          const admission = parentTurnData.permissionReview?.admission
          if (!validPermissionReviewAdmission(admission) || !admission.complete) return
          return {
            rootSessionID: edge.root_session_id,
            rootTurnID: edge.root_turn_id,
            trusted: admission.text.map((text) => ({ source: "human" as const, text, id: edge.root_turn_id })),
          }
        }
        sessionID = parent.id
        turnID = edge.parent_turn_id
      }
    })

    const resolveDirectAuthority = Effect.fn("Permission.resolveDirectAuthority")(function* (
      sessionID: SessionID,
      turnID: MessageID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (session.parentID !== undefined) return
      const turn = yield* sessions.findMessage(sessionID, (message) => message.info.id === turnID)
      if (Option.isNone(turn) || turn.value.info.role !== "user") return
      const admission = turn.value.info.permissionReview?.admission
      if (!validPermissionReviewAdmission(admission) || !admission.complete) return
      return {
        rootSessionID: sessionID,
        rootTurnID: turnID,
        trusted: admission.text.map((text) => ({ source: "human" as const, text, id: turnID })),
      }
    })

    const directAuthorityExists = Effect.fn("Permission.directAuthorityExists")(function* (
      sessionID: SessionID,
      turnID: MessageID,
    ) {
      return (yield* resolveDirectAuthority(sessionID, turnID)) !== undefined
    })

    const sameEvidence = (left: readonly EvidenceInput[], right: readonly EvidenceInput[]) =>
      left.length === right.length &&
      left.every((item, index) => item.source === right[index]?.source && item.text === right[index]?.text)

    const sameReviewTurn = (left: TurnState, right: TurnState) =>
      left.rootSessionID === right.rootSessionID &&
      left.rootTurnID === right.rootTurnID &&
      left.turnID === right.turnID &&
      left.directPromptAdmission === right.directPromptAdmission &&
      left.delegatedPromptAdmission === right.delegatedPromptAdmission &&
      left.trustedComplete === right.trustedComplete &&
      left.untrustedComplete === right.untrustedComplete &&
      left.contextSafeForGate === right.contextSafeForGate &&
      left.rewrite.status === right.rewrite.status &&
      sameEvidence(left.trusted, right.trusted) &&
      sameEvidence(left.untrusted, right.untrusted)

    const captureTurn: Interface["captureTurn"] = Effect.fn("Permission.captureTurn")(function* (input) {
      const current = yield* InstanceState.get(state)
      const untrusted = boundedEvidence(input.untrusted)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const persisted = yield* sessions
        .findMessage(input.sessionID, (message) => message.info.id === input.turnID)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())))
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
        validPermissionReviewAdmission(persisted.value.info.permissionReview?.admission) &&
        persisted.value.info.permissionReview.admission.complete
      const delegated = session?.parentID
        ? yield* resolveDelegatedAuthority({ childSessionID: input.sessionID, childTurnID: input.turnID }).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
        : undefined
      const directTrusted =
        directPromptAdmission && Option.isSome(persisted) && persisted.value.info.role === "user"
          ? persisted.value.info.permissionReview!.admission.text.map((text) => ({
              source: "human" as const,
              text,
              id: input.turnID,
            }))
          : undefined
      const trusted = boundedTrustedEvidence(delegated?.trusted ?? directTrusted ?? input.trusted)
      const authorityComplete = directPromptAdmission || delegated !== undefined
      const trustedInputComplete = input.trustedComplete ?? input.complete ?? true
      const untrustedInputComplete = input.untrustedComplete ?? input.complete ?? true
      const effectiveRootSessionID = delegated?.rootSessionID ?? input.rootSessionID
      const key = turnKey(input.sessionID, input.turnID)
      const previous = current.turns.get(key)
      const rewrite: RewriteState =
        !markerHealthy || correctionUsed
          ? { status: "used" }
          : previous?.turnID === input.turnID
            ? previous.rewrite
            : { status: "available" }
      const previousTurn = current.turns.get(key)
      remember(current.turns, key, {
        trusted: trusted.items,
        untrusted: untrusted.items,
        rootSessionID: effectiveRootSessionID,
        rootTurnID: delegated?.rootTurnID ?? input.turnID,
        turnID: input.turnID,
        directPromptAdmission,
        delegatedPromptAdmission: delegated !== undefined,
        rewrite:
          previousTurn?.turnID === input.turnID
            ? previousTurn.rewrite
            : directPromptAdmission
              ? rewrite
              : { status: "used" },
        trustedComplete: authorityComplete && trustedInputComplete && trusted.complete,
        untrustedComplete: untrustedInputComplete && untrusted.complete,
        // Untrusted evidence may be explicitly lossy after compaction or bounding. Keep that fact in
        // untrustedComplete for the reviewer, but do not let it revoke a complete persisted human admission.
        contextSafeForGate: authorityComplete && input.contextSafeForGate === true && trusted.complete,
      })
      remember(current.activeTurns, input.sessionID, key)
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
      const key = turnKey(input.sessionID, input.turnID)
      const turn = current.turns.get(key)
      if (!turn) return
      const untrusted = boundedEvidence([...turn.untrusted, ...input.evidence])
      remember(current.turns, key, {
        ...turn,
        untrusted: untrusted.items,
        untrustedComplete: turn.untrustedComplete && untrusted.complete,
        contextSafeForGate: turn.contextSafeForGate,
      })
    })

    const authoriseTaskDelegation: Interface["authoriseTaskDelegation"] = Effect.fn(
      "Permission.authoriseTaskDelegation",
    )(function* (input) {
      const current = yield* InstanceState.get(state)
      const message = yield* sessions
        .findMessage(SessionID.make(input.sessionID), (item) => item.info.id === input.messageID)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())))
      if (Option.isNone(message) || message.value.info.role !== "assistant") return undefined
      const parentTurnID = message.value.info.parentID
      const turn = current.turns.get(turnKey(input.sessionID, parentTurnID))
      if (
        !turn ||
        !turn.contextSafeForGate ||
        !turn.trustedComplete ||
        (!turn.directPromptAdmission && !turn.delegatedPromptAdmission) ||
        turn.trusted.length === 0 ||
        turn.trusted.some((item) => item.source !== "human")
      )
        return undefined
      const parts = message.value.parts.filter(
        (part) => part.type === "tool" && part.tool === "task" && part.callID === input.callID,
      )
      if (parts.length !== 1) return undefined
      const task = parts[0]!
      if (task.type !== "tool") return undefined
      const taskInput = task.state.input
      if (
        taskInput === null ||
        typeof taskInput !== "object" ||
        Array.isArray(taskInput) ||
        taskInput.subagent_type !== input.childAgent
      )
        return undefined
      const receipt = randomUUID()
      remember(current.taskReceipts, receipt, {
        parentSessionID: input.sessionID,
        parentTurnID,
        taskMessageID: input.messageID,
        taskPartID: task.id,
        taskCallID: input.callID,
        childAgent: input.childAgent,
      })
      return receipt
    })

    const captureTaskDelegation: Interface["captureTaskDelegation"] = Effect.fn("Permission.captureTaskDelegation")(
      function* (input) {
        const current = yield* InstanceState.get(state)
        const receipt = current.taskReceipts.get(input.receipt)
        current.taskReceipts.delete(input.receipt)
        if (!receipt) throw new Error("Task delegation receipt is missing or already used")

        const child = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(input.childSessionID)))
          .get()
        const parent = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionID.make(receipt.parentSessionID)))
          .get()
        const childTurn = yield* db
          .select({ sessionID: MessageTable.session_id, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, MessageID.make(input.childTurnID)))
          .get()
        const taskMessage = yield* db
          .select({ sessionID: MessageTable.session_id, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, MessageID.make(receipt.taskMessageID)))
          .get()
        const parentTurn = yield* db
          .select({ sessionID: MessageTable.session_id, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, MessageID.make(receipt.parentTurnID)))
          .get()
        const taskPart = yield* db
          .select({ messageID: PartTable.message_id, sessionID: PartTable.session_id, data: PartTable.data })
          .from(PartTable)
          .where(eq(PartTable.id, PartID.make(receipt.taskPartID)))
          .get()
        const childTurnData = childTurn?.data as SessionV1.Info | undefined
        const parentTurnData = parentTurn?.data as SessionV1.Info | undefined
        const taskMessageData = taskMessage?.data as SessionV1.Info | undefined
        const taskPartData = taskPart?.data as unknown as SessionV1.Part | undefined
        if (
          !child ||
          !parent ||
          child.parent_id !== parent.id ||
          !sameSessionScope(child, parent) ||
          child.agent !== receipt.childAgent ||
          !childTurn ||
          childTurn.sessionID !== child.id ||
          childTurnData?.role !== "user" ||
          childTurnData.agent !== receipt.childAgent ||
          !parentTurn ||
          parentTurn.sessionID !== parent.id ||
          parentTurnData?.role !== "user" ||
          !taskMessage ||
          taskMessage.sessionID !== parent.id ||
          taskMessageData?.role !== "assistant" ||
          taskMessageData.parentID !== receipt.parentTurnID ||
          !taskPart ||
          taskPart.messageID !== receipt.taskMessageID ||
          taskPart.sessionID !== parent.id ||
          taskPartData?.type !== "tool" ||
          taskPartData.tool !== "task" ||
          taskPartData.callID !== receipt.taskCallID ||
          !("metadata" in taskPartData.state) ||
          taskPartData.state.metadata?.parentSessionId !== parent.id ||
          taskPartData.state.metadata.sessionId !== child.id ||
          taskPartData.state.metadata.truncated === true
        )
          throw new Error("Task delegation provenance is incomplete or mismatched")

        const parentAuthority =
          parent.parent_id === null
            ? validPermissionReviewAdmission(parentTurnData.permissionReview?.admission) &&
              parentTurnData.permissionReview?.admission.complete
              ? { rootSessionID: parent.id, rootTurnID: receipt.parentTurnID }
              : undefined
            : yield* resolveDelegatedAuthority({
                childSessionID: parent.id,
                childTurnID: receipt.parentTurnID,
              })
        if (!parentAuthority) throw new Error("Task delegation has no complete admitted root authority")

        yield* db
          .insert(PermissionReviewDelegationTable)
          .values({
            child_turn_id: MessageID.make(input.childTurnID),
            child_session_id: child.id,
            parent_turn_id: MessageID.make(receipt.parentTurnID),
            parent_session_id: parent.id,
            root_turn_id: MessageID.make(parentAuthority.rootTurnID),
            root_session_id: SessionID.make(parentAuthority.rootSessionID),
            task_message_id: MessageID.make(receipt.taskMessageID),
            task_part_id: PartID.make(receipt.taskPartID),
            task_call_id: receipt.taskCallID,
            child_agent: receipt.childAgent,
          })
          .run()
        const valid = yield* resolveDelegatedAuthority({
          childSessionID: child.id,
          childTurnID: input.childTurnID,
        })
        if (!valid) {
          yield* db
            .delete(PermissionReviewDelegationTable)
            .where(eq(PermissionReviewDelegationTable.child_turn_id, MessageID.make(input.childTurnID)))
            .run()
          throw new Error("Task delegation failed final provenance validation")
        }
      },
    )

    const canResumeTask: Interface["canResumeTask"] = Effect.fn("Permission.canResumeTask")(function* (input) {
      const edges = yield* db
        .select({ childTurnID: PermissionReviewDelegationTable.child_turn_id })
        .from(PermissionReviewDelegationTable)
        .where(
          and(
            eq(PermissionReviewDelegationTable.parent_session_id, SessionID.make(input.parentSessionID)),
            eq(PermissionReviewDelegationTable.child_session_id, SessionID.make(input.childSessionID)),
            eq(PermissionReviewDelegationTable.child_agent, input.childAgent),
          ),
        )
        .all()
      for (const edge of edges) {
        const valid = yield* resolveDelegatedAuthority({
          childSessionID: input.childSessionID,
          childTurnID: edge.childTurnID,
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (valid) return true
      }
      return false
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
      candidateRejection?: PermissionReviewer.GenericRiskCandidateRejection
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
          ...(input.candidateRejection ? { candidateRejection: input.candidateRejection } : {}),
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
      const permissionSession = yield* sessions.get(info.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const toolMessage = info.tool
        ? yield* sessions
            .findMessage(info.sessionID, (message) => message.info.id === info.tool!.messageID)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())))
        : Option.none()
      const activeTurnKey =
        Option.isSome(toolMessage) && toolMessage.value.info.role === "assistant"
          ? turnKey(info.sessionID, toolMessage.value.info.parentID)
          : current.activeTurns.get(info.sessionID)
      let turn = (activeTurnKey ? current.turns.get(activeTurnKey) : undefined) ?? {
        trusted: [],
        untrusted: [],
        rootSessionID: "",
        rootTurnID: "",
        turnID: "",
        directPromptAdmission: false,
        delegatedPromptAdmission: false,
        rewrite: { status: "used" } as RewriteState,
        trustedComplete: false,
        untrustedComplete: false,
        contextSafeForGate: false,
      }
      if (turn.directPromptAdmission) {
        const direct = yield* directAuthorityExists(SessionID.make(info.sessionID), MessageID.make(turn.turnID)).pipe(
          Effect.catchCause(() => Effect.succeed(false)),
        )
        if (!direct) turn = { ...turn, trusted: [], trustedComplete: false, contextSafeForGate: false }
      } else if (turn.delegatedPromptAdmission) {
        const delegated = yield* resolveDelegatedAuthority({
          childSessionID: info.sessionID,
          childTurnID: turn.turnID,
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        turn = delegated
          ? { ...turn, trusted: delegated.trusted, trustedComplete: true }
          : { ...turn, trusted: [], trustedComplete: false, contextSafeForGate: false }
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
      const reviewTurn = turn
      const reviewActionBinding = JSON.stringify(snapshot.action)
      const externalReadScopeRequest = permissionSession
        ? yield* inspectExternalReadScope({
            info,
            snapshot,
            turn,
            directory: permissionSession.directory,
          }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const readScopeGate = yield* readScopeAllowsExternalGate(current, externalReadScopeRequest, turn).pipe(
        Effect.catchCause(() => Effect.succeed(false)),
      )
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
        !readScopeGate &&
        ((!evaluatorEnforcing && !evaluatorPermitOnly) ||
          (evaluatorEnforcing && evaluatorDecision === "noop") ||
          (evaluatorPermitOnly && evaluatorPermitDecision !== "allow" && evaluatorPermitDecision !== "deny"))
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
      let authorityRejection: PermissionReviewer.GenericRiskCandidateRejection | undefined
      const rejectAuthority = (code: PermissionReviewer.GenericRiskCandidateRejection) => {
        authorityRejection = code
        return false
      }
      const revalidateAuthority = Effect.fn("Permission.revalidateAuthority")(function* () {
        if (!activeTurnKey || current.activeTurns.get(info.sessionID) !== activeTurnKey)
          return rejectAuthority("authority_turn_changed")
        const active = current.turns.get(activeTurnKey)
        if (!active || !sameReviewTurn(active, reviewTurn)) return rejectAuthority("authority_turn_changed")
        const currentSnapshot = buildPermissionReviewSnapshot({
          permission: info.permission,
          origin: source?.origin ?? "unknown",
          patterns: info.patterns,
          metadata: info.metadata,
          action: source?.action ?? {
            identity: info.permission,
            arguments: source?.arguments,
            complete: false,
          },
          trusted: active.trusted,
          untrusted: active.untrusted,
          trustedComplete: active.trustedComplete,
          untrustedComplete: active.untrustedComplete,
          contextSafeForGate: active.contextSafeForGate,
        })
        if (JSON.stringify(currentSnapshot.action) !== reviewActionBinding)
          return rejectAuthority("authority_action_changed")
        if (info.tool) {
          const persistedToolMessage = yield* sessions
            .findMessage(info.sessionID, (message) => message.info.id === info.tool!.messageID)
            .pipe(Effect.catch(() => Effect.succeed(Option.none())))
          if (Option.isSome(persistedToolMessage) && persistedToolMessage.value.info.role === "assistant") {
            if (persistedToolMessage.value.info.parentID !== active.turnID)
              return rejectAuthority("authority_turn_changed")
          } else if (current.activeTurns.get(info.sessionID) !== activeTurnKey)
            return rejectAuthority("authority_turn_changed")
        } else if (current.activeTurns.get(info.sessionID) !== activeTurnKey)
          return rejectAuthority("authority_turn_changed")

        const authority = active.directPromptAdmission
          ? yield* resolveDirectAuthority(SessionID.make(info.sessionID), MessageID.make(active.turnID)).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
          : active.delegatedPromptAdmission
            ? yield* resolveDelegatedAuthority({ childSessionID: info.sessionID, childTurnID: active.turnID }).pipe(
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
            : undefined
        if (
          !authority ||
          authority.rootSessionID !== active.rootSessionID ||
          authority.rootTurnID !== active.rootTurnID ||
          !sameEvidence(authority.trusted, active.trusted) ||
          snapshot.trusted.items.length !== authority.trusted.length ||
          !authority.trusted.every((item, index) => {
            const reviewed = snapshot.trusted.items[index]
            return reviewed?.source === item.source && reviewed.text === item.text
          })
        )
          return rejectAuthority("authority_evidence_changed")
        if (!active.contextSafeForGate) return rejectAuthority("context_unsafe")
        if (!active.trustedComplete) return rejectAuthority("trusted_evidence_incomplete")
        return true
      })
      const safelyRevalidateAuthority = () =>
        revalidateAuthority().pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              authorityRejection = "authority_revoked"
              return false
            }),
          ),
        )
      const finalAuthority = yield* inspectThenRevalidateAuthority(safelyRevalidateAuthority, () =>
        Effect.gen(function* () {
          const externalReadScopeRequest = permissionSession
            ? yield* inspectExternalReadScope({
                info,
                snapshot,
                turn: reviewTurn,
                directory: permissionSession.directory,
              }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            : undefined
          const readScopeGate = yield* readScopeAllowsExternalGate(current, externalReadScopeRequest, reviewTurn).pipe(
            Effect.catchCause(() => Effect.succeed(false)),
          )
          const readScopePrimary = permissionSession
            ? yield* readScopeAllowsPrimary({
                current,
                info,
                snapshot,
                turn: reviewTurn,
                directory: permissionSession.directory,
              }).pipe(Effect.catchCause(() => Effect.succeed(false)))
            : false
          return { externalReadScopeRequest, readScopeGate, readScopePrimary }
        }),
      )
      // inspectThenRevalidateAuthority performs the persisted check as its final yielded operation. Do not add an
      // await between this point and disposition or read-scope mutation.
      const authorityStillCurrent = finalAuthority.authorityCurrent
      const inspectedExternalReadScopeRequest = finalAuthority.inspection?.externalReadScopeRequest
      const inspectedReadScopeGate = finalAuthority.inspection?.readScopeGate ?? false
      const inspectedReadScopePrimary = finalAuthority.inspection?.readScopePrimary ?? false
      const finalExternalReadScopeRequest = authorityStillCurrent ? inspectedExternalReadScopeRequest : undefined
      const finalReadScopeGate = authorityStillCurrent && inspectedReadScopeGate
      const finalReadScopePrimary = authorityStillCurrent && inspectedReadScopePrimary
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
        authorityStillCurrent &&
        automaticRiskConfig &&
        riskPolicyAssessment !== undefined &&
        PermissionReviewer.isObviousRiskCandidate({
          settled: builtin?.run.isSettled() ?? false,
          permission: info.permission,
          assessment: riskPolicyAssessment,
          snapshot,
          policy: riskPolicy,
        })
      const genericRiskCandidate =
        authorityStillCurrent &&
        automaticRiskConfig &&
        riskPolicyAssessment !== undefined &&
        PermissionReviewer.isGenericRiskCandidate({
          settled: builtin?.run.isSettled() ?? false,
          permission: info.permission,
          assessment: riskPolicyAssessment,
          snapshot,
          policy: riskPolicy,
          directory: permissionSession?.directory,
          allowExternalReadScope: finalReadScopePrimary,
        })
      const genericCandidateRejection =
        authorityRejection ??
        (automaticRiskConfig &&
        riskPolicyAssessment !== undefined &&
        info.permission !== "external_directory" &&
        snapshot.action.identity !== "bash"
          ? PermissionReviewer.genericRiskCandidateRejection({
              settled: builtin?.run.isSettled() ?? false,
              permission: info.permission,
              assessment: riskPolicyAssessment,
              snapshot,
              policy: riskPolicy,
              directory: permissionSession?.directory,
              allowExternalReadScope: finalReadScopePrimary,
            })
          : undefined)
      const externalDirectoryReviewCandidate =
        authorityStillCurrent &&
        automaticRiskConfig &&
        riskPolicyAssessment !== undefined &&
        PermissionReviewer.isExternalDirectoryRiskAllowCandidate({
          settled: builtin?.run.isSettled() ?? false,
          permission: info.permission,
          assessment: riskPolicyAssessment,
          snapshot,
          policy: riskPolicy,
        })
      const externalDirectoryAllowCandidate =
        externalDirectoryReviewCandidate &&
        (snapshot.action.identity === "bash" || finalExternalReadScopeRequest !== undefined)
      if (pluginResult === "deny") result = "deny"
      else if (
        (evaluatorEnforcing && evaluatorDecision === "deny") ||
        (evaluatorPermitOnly && evaluatorPermitDecision === "deny")
      )
        result = "deny"
      else if (pluginResult === "ask") result = "ask"
      else if (evaluatorEnforcing && !evaluatorPermits) result = "ask"
      else if (finalReadScopeGate && otherSourcesPermit) result = "allow"
      else if (builtinResult && "failure" in builtinResult) result = "ask"
      else if (riskPolicyAssessment) {
        if (
          riskPolicyAssessment.outcome === "allow" &&
          reviewerConfig?.automatic_allow === "policy-gated" &&
          (bashRiskCandidate || genericRiskCandidate || externalDirectoryAllowCandidate) &&
          otherSourcesPermit
        ) {
          result = "allow"
        } else if (
          riskPolicyAssessment.outcome === "rewrite" &&
          reviewerConfig?.automatic_rewrite === "once-per-turn" &&
          (bashRiskCandidate || genericRiskCandidate) &&
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

      let readScopeCode: ReadScopeCode | undefined
      if (
        result === "allow" &&
        !finalReadScopeGate &&
        externalDirectoryAllowCandidate &&
        riskPolicyAssessment?.outcome === "allow" &&
        reviewerConfig?.automatic_allow === "policy-gated" &&
        otherSourcesPermit &&
        finalExternalReadScopeRequest
      ) {
        readScopeCode = rememberReadScope(current, finalExternalReadScopeRequest)
      } else if (result === "allow" && finalReadScopeGate) {
        readScopeCode = "read_scope_reused"
      }

      const latencyMs = (yield* Clock.currentTimeMillis) - started
      if (readScopeCode) yield* auditReadScope({ info, origin: review.origin, code: readScopeCode })
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
          candidateRejection: genericCandidateRejection,
          dispositionAuthority: result === "allow" ? "automatic_allow" : result === "deny" ? "deny" : "human",
        })
      }

      if (result === "allow") return
      if (result === "rewrite" && correctionFeedback) {
        const token = yield* Effect.sync(() => {
          const active = activeTurnKey ? current.turns.get(activeTurnKey) : undefined
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
                candidateRejection: genericCandidateRejection,
                dispositionAuthority: "automatic_rewrite",
              })
            }
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const claimed = yield* Effect.sync(() => {
                  const active = activeTurnKey ? current.turns.get(activeTurnKey) : undefined
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
                const authorityAfterPersist = yield* safelyRevalidateAuthority()
                yield* Effect.sync(() => {
                  const active = activeTurnKey ? current.turns.get(activeTurnKey) : undefined
                  if (
                    active?.turnID === turn.turnID &&
                    active.rewrite.status === "persisting" &&
                    active.rewrite.token === token
                  )
                    active.rewrite = { status: "used" }
                })
                if (Exit.isFailure(persisted) || persisted.value !== "inserted" || !authorityAfterPersist) return false
                return yield* new PermissionV1.PolicyCorrectionError({ feedback: correctionFeedback })
              }),
            )
          }).pipe(
            Effect.onExit(() =>
              Effect.sync(() => {
                const active = activeTurnKey ? current.turns.get(activeTurnKey) : undefined
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
            candidateRejection: genericCandidateRejection,
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

    return Service.of({
      ask,
      reply,
      list,
      captureTurn,
      captureUntrusted,
      authoriseTaskDelegation,
      captureTaskDelegation,
      canResumeTask,
    })
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
