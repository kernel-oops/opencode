/**
 * Plugin-only contract for an explicitly opted-in, same-session controller-state checkpoint.
 *
 * The state is reviewed evidence, never permission. Core owns revisions, coverage and the native commit; a plugin
 * only calls these methods from a live tool invocation and echoes the core rendering in the compaction hook. Nothing
 * here is an HTTP endpoint, a generated client surface or an approval capability.
 */

import type { Session } from "@opencode/schema/session"

/** A pointer to original evidence: a same-session (or proven-lineage) message, or a hashed external file. */
export type SourceRef =
  | {
      readonly kind: "message"
      readonly sessionID: string
      readonly messageID: string
      readonly callID?: string
    }
  /** Evidence pointer only: its hash proves neither authority nor currency. Never read by core. */
  | { readonly kind: "file"; readonly path: string; readonly sha256: string; readonly section?: string }

/** Known, reported or explicitly unknown; never an empty-string convention. */
export type Fact =
  | { readonly status: "known"; readonly value: string; readonly evidence: ReadonlyArray<SourceRef> }
  | { readonly status: "reported"; readonly value: string; readonly evidence: ReadonlyArray<SourceRef> }
  | { readonly status: "unknown"; readonly reason: string; readonly evidence: ReadonlyArray<SourceRef> }

/** Exact native boundary a reviewed state covers. Copy it from a snapshot; do not construct it. */
export interface Coverage {
  /** Row sequence of the latest completed checkpoint marker before this coverage, or 0 for none. */
  readonly checkpointSeq: number
  /**
   * First row sequence of the fingerprinted window: the whole prior native context window, including original rows a
   * previous checkpoint retained from before its own marker.
   */
  readonly fromSeq: number
  readonly coveredSeq: number
  readonly coveredMessageID: string
  /** SHA-256 of the original rows from `fromSeq` through `coveredSeq`, including their current content. */
  readonly prefixHash: string
  /** Durable user-admission revision; any later user admission conservatively invalidates the coverage. */
  readonly userAdmission: number
  readonly instructionHash: string
  readonly directory: string
}

export interface State {
  readonly version: 1
  readonly sessionID: string
  readonly owner: { readonly sessionID: string; readonly workdir: string }
  readonly authority: ReadonlyArray<{
    readonly source: SourceRef
    readonly exactText: string
    readonly scope: string
    readonly status: string
    readonly negativeConstraints: ReadonlyArray<string>
    readonly supersededBy?: SourceRef
  }>
  readonly budgets: ReadonlyArray<{
    readonly id: string
    readonly source: SourceRef
    readonly unit: string
    /** Exact decimal strings, or `"unknown"`. Unknown consumption cannot leave a known remainder. */
    readonly allocation: string
    readonly consumed: string
    readonly remaining: string
    readonly expires: string
    readonly oneOff: boolean
    readonly outcome: string
  }>
  readonly pins: { readonly candidate: Fact; readonly deployed: Fact; readonly canonical: Fact }
  readonly jobs: ReadonlyArray<{
    readonly id: Fact
    readonly ownerSessionID: string
    readonly callbackOwnerSessionID: string
    readonly kind: string
    readonly state: string
    readonly deliveryExpectation: string
    readonly evidence: ReadonlyArray<SourceRef>
  }>
  readonly reminders: ReadonlyArray<{
    readonly id: Fact
    readonly ownerSessionID: string
    readonly purpose: string
    readonly state: string
    readonly evidence: ReadonlyArray<SourceRef>
  }>
  readonly unresolved: ReadonlyArray<{
    readonly id: string
    readonly questionOrOutcome: string
    readonly state: string
    readonly safeDefault: string
    readonly evidence: ReadonlyArray<SourceRef>
  }>
  readonly evidence: ReadonlyArray<SourceRef>
  /**
   * `reviewedStateHash` is the review target: the SHA-256 of the canonical JSON of this state without `review`. The
   * receipt's `stateHash` is a different domain, the complete state including this envelope; neither is
   * self-referential.
   */
  readonly review: {
    readonly reviewedStateHash: string
    readonly reviewerEvidence: ReadonlyArray<SourceRef>
    readonly reviewedAt: string
    readonly completenessAttestation: string
    readonly currentThrough: Coverage
  }
}

/** The live tool invocation calling core; core proves it is running in the session. */
export interface Source {
  readonly messageID: string
  readonly callID: string
}

export type ErrorCode =
  | "invalid_source"
  | "invalid_state"
  | "state_too_large"
  | "stale_revision"
  | "snapshot_invalid"
  | "coverage_changed"
  | "unsettled"
  | "not_enabled"
  | "already_consumed"
  | "compaction_pending"
  | "enable_unauthorised"
  | "expired"
  | "recovery_required"
  | "maintenance_unavailable"
  | "intent_required"

export type Result<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly error: ErrorCode; readonly message: string }

export interface Receipt {
  readonly revision: number
  /** SHA-256 of the canonical complete state, review envelope included. */
  readonly stateHash: string
  readonly enabled: boolean
  readonly coverage: Coverage
  /** Epoch milliseconds after which this revision can no longer be checkpointed; taken from its snapshot. */
  readonly expires: number
  /** The exact checkpoint message (its row sequence) and the native event that completed it. */
  readonly consumed?: {
    readonly requestID: string
    readonly messageID: string
    readonly messageSeq: number
    readonly eventSeq: number
  }
}

export interface Status {
  readonly current?: Receipt
  /** Latest checkpoint outcome; a blocked one is never a successful checkpoint. */
  readonly outcome?: { readonly requestID: string; readonly status: "completed" | "blocked"; readonly message: string }
  readonly state?: State
}

/**
 * A detached copy of the binding a state checkpoint passes to compaction hooks. A hook must set `result.summary` to
 * `rendered`; core compares with its own copy, so editing this one changes nothing.
 */
export interface CheckpointBinding {
  readonly revision: number
  readonly stateHash: string
  readonly coverage: Coverage
  readonly rendered: string
}

export type ReadResult = Result<Status>

/** Inputs of the plugin-only session domain methods; `source` is the calling tool invocation, not user text. */
export interface Call {
  readonly sessionID: Session.ID
  readonly source: Source
}
export interface ReadInput extends Call {
  /** Also return the current state, not just its receipt and latest outcome. */
  readonly state?: boolean
}
export interface UpdateInput extends Call {
  readonly expectedRevision: number
  readonly snapshotID: string
  /** The complete next state; validated by core against the closed schema. Never merged. */
  readonly state: unknown
  readonly enabled: boolean
}
export interface CompactInput extends Call {
  readonly expectedRevision: number
  /** Stable message ID for an idempotent retry; core creates one when absent. */
  readonly requestID?: string
}

/**
 * Operator maintenance while the context budget blocks the selected model: no live tool call and no model turn.
 * Each operation needs a fresh native shell intent in the same session whose command is exactly the comment core
 * names for this operation, revision and hash. That shell message is native API origin, not cryptographic proof of
 * a human, and it never enables checkpoints: the session must already be opted in. All other checks are unchanged.
 */
export interface MaintainInput {
  readonly sessionID: Session.ID
  readonly operation: "snapshot" | "update" | "compact"
  /** The current revision; for `update`, the revision the new state replaces. */
  readonly expectedRevision: number
  /** `update` only. */
  readonly snapshotID?: string
  readonly state?: unknown
  /** `compact` only. */
  readonly requestID?: string
}
export type MaintainResult = Result<{
  readonly snapshotID?: string
  readonly revision?: number
  readonly coverage?: Coverage
  readonly receipt?: Receipt
  readonly requestID?: string
  readonly stateHash?: string
}> & {
  /** With `intent_required`: the exact shell command that authorises this operation. */
  readonly intent?: string
}

export type SnapshotResult = Result<{ readonly snapshotID: string; readonly revision: number; readonly coverage: Coverage }>
export type UpdateResult = Result<{ readonly receipt: Receipt }>
export type CompactResult = Result<{ readonly requestID: string; readonly revision: number; readonly stateHash: string }>
