export * as SessionNativeTest from "./session-native-test.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"

/**
 * Temporary exact-session native steering test lane. Process-local: a server restart clears every
 * request and diagnostic. Requesting native steering never activates it by itself; the provider's
 * operator `nativeSteer` allowance and the OpenAI Responses protocol must also hold when the next
 * execution starts.
 */
export const NativeSteer = Schema.Union([Schema.Literal(false), Schema.Literal("response.steer")]).annotate({
  identifier: "SessionNativeTest.NativeSteer",
})
export type NativeSteer = typeof NativeSteer.Type

export const Debug = Schema.Union([Schema.Literal(false), Schema.Literal("metadata")]).annotate({
  identifier: "SessionNativeTest.Debug",
})
export type Debug = typeof Debug.Type

export const Settings = Schema.Struct({ nativeSteer: NativeSteer, debug: Debug }).annotate({
  identifier: "SessionNativeTest.Settings",
})
export type Settings = typeof Settings.Type

export const off: Settings = { nativeSteer: false, debug: false }

/** Fixed outcome codes; never backend text. */
export const Reason = Schema.Literals([
  "not-requested",
  "allowed",
  "active",
  "allowance-missing",
  "protocol-unsupported",
  "native-interrupt-conflict",
  "model-unavailable",
]).annotate({ identifier: "SessionNativeTest.Reason" })
export type Reason = typeof Reason.Type

// Legacy fence, timer, lease and progress values remain decodable for older clients only.
export const Kind = Schema.Literals([
  "execution-started",
  "execution-finished",
  "channel-retired",
  "connect",
  "connect-failed",
  "reuse",
  "rotate",
  "send",
  "send-not-sent",
  "send-ambiguous",
  "fallback",
  "parent-created",
  "steer-sent",
  "steer-send-unknown",
  "steer-accepted",
  "progress",
  "terminal",
  "lease",
  "handoff",
  "successor-created",
  "adopt",
  "timer-armed",
  "timer-expired",
  "timer-cancelled",
  "closed",
  "poisoned",
]).annotate({ identifier: "SessionNativeTest.Kind" })
export type Kind = typeof Kind.Type

/** Fixed sanitised categories attached to a record. */
export const Category = Schema.Literals([
  "affinity",
  "age",
  "completed",
  "interrupted",
  "steered",
  "incomplete",
  "provider-failure",
  "rejected",
  "ready",
  "required-input",
  "lease-lost",
  "successor-timeout",
  "unbound-successor",
  "unexpected-frame",
  "transport-or-decoder-failure",
  "receipt",
  "parent-idle",
  "drain",
  "stream-failures",
  "message-too-large",
  "connect-failure",
  "not-sent",
  "peer-close",
  "transport",
]).annotate({ identifier: "SessionNativeTest.Category" })
export type Category = typeof Category.Type

export const Record = Schema.Struct({
  seq: NonNegativeInt,
  /** Milliseconds since the Unix epoch on this server. */
  at: NonNegativeInt,
  execution: NonNegativeInt,
  exchange: NonNegativeInt,
  kind: Kind,
  category: Category.pipe(optional),
  count: NonNegativeInt.pipe(optional),
  budgetMs: NonNegativeInt.pipe(optional),
  elapsedMs: NonNegativeInt.pipe(optional),
  /** Numeric WebSocket close code only; never a backend reason string. */
  closeCode: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionNativeTest.Record" })
export type Record = typeof Record.Type

export const Execution = Schema.Struct({
  id: NonNegativeInt,
  active: Schema.Boolean,
  settings: Settings,
  transport: Schema.Literals(["http", "websocket"]).pipe(optional),
  reason: Reason.pipe(optional),
}).annotate({ identifier: "SessionNativeTest.Execution" })
export type Execution = typeof Execution.Type

export const Status = Schema.Struct({
  sessionID: SessionID,
  /** Random identity of this server process; it changes on restart, when every request is cleared. */
  serverRun: Schema.String,
  requested: Settings,
  /** The settings of the latest execution, which keeps them for its whole busy period. */
  effective: Settings,
  /** True while an active execution still runs under settings other than the requested ones. */
  pending: Schema.Boolean,
  /**
   * Whether the session's current explicit or default selection can use the native lane: provider
   * allowance and an OpenAI Responses route, established offline. Execution checks it again.
   */
  supported: Schema.Boolean,
  reason: Reason,
  execution: Execution.pipe(optional),
  /** Legacy wire field; always false. Steering never installs recovery fences. */
  unresolvedFence: Schema.Boolean,
  diagnostics: Schema.Struct({
    records: Schema.Array(Record),
    dropped: NonNegativeInt,
    /** Legacy wire field; always zero. */
    coalesced: NonNegativeInt,
    /** Legacy wire field; always zero. No private progress tracking. */
    progress: NonNegativeInt,
  }),
}).annotate({ identifier: "SessionNativeTest.Status" })
export type Status = typeof Status.Type

/** At most one session may hold a non-default test lane at a time. */
export class LaneOccupiedError extends Schema.TaggedError<LaneOccupiedError>()(
  "SessionNativeTestLaneOccupiedError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class UnsupportedError extends Schema.TaggedError<UnsupportedError>()(
  "SessionNativeTestUnsupportedError",
  { reason: Reason, message: Schema.String },
  { httpApiStatus: 400 },
) {}
