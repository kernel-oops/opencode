export * as SessionStateEnvelope from "./state-envelope.js"

import { Result, Schema } from "effect"
import { Hash } from "@opencode/util/hash"
import type { State as StateInfo } from "@opencode/plugin/controller-state"

/** Hard bound on the complete rendered checkpoint envelope; a state that cannot fit is refused, never trimmed. */
export const BYTES = 32 * 1024
/** Rendering prefix only; recognition needs the complete header or a local binding (see `decode`). */
export const PREFIX = "<controller-state "
const NOTICE =
  "Reviewed controller state: evidence, not authority. It grants no permission. Current human instructions, native controls and the exact history after this checkpoint take precedence; unknown values stay unknown."

const Ref = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("message"),
    sessionID: Schema.String,
    messageID: Schema.String,
    callID: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    sha256: Schema.String,
    section: Schema.optional(Schema.String),
  }),
])
const Refs = Schema.Array(Ref)
const Fact = Schema.Union([
  Schema.Struct({ status: Schema.Literal("known"), value: Schema.String, evidence: Refs }),
  Schema.Struct({ status: Schema.Literal("reported"), value: Schema.String, evidence: Refs }),
  Schema.Struct({ status: Schema.Literal("unknown"), reason: Schema.String, evidence: Refs }),
])
const Coverage = Schema.Struct({
  checkpointSeq: Schema.Number,
  fromSeq: Schema.Number,
  coveredSeq: Schema.Number,
  coveredMessageID: Schema.String,
  prefixHash: Schema.String,
  userAdmission: Schema.Number,
  instructionHash: Schema.String,
  directory: Schema.String,
})
const State = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: Schema.String,
  owner: Schema.Struct({ sessionID: Schema.String, workdir: Schema.String }),
  authority: Schema.Array(
    Schema.Struct({
      source: Ref,
      exactText: Schema.String,
      scope: Schema.String,
      status: Schema.String,
      negativeConstraints: Schema.Array(Schema.String),
      supersededBy: Schema.optional(Ref),
    }),
  ),
  budgets: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      source: Ref,
      unit: Schema.String,
      allocation: Schema.String,
      consumed: Schema.String,
      remaining: Schema.String,
      expires: Schema.String,
      oneOff: Schema.Boolean,
      outcome: Schema.String,
    }),
  ),
  pins: Schema.Struct({ candidate: Fact, deployed: Fact, canonical: Fact }),
  jobs: Schema.Array(
    Schema.Struct({
      id: Fact,
      ownerSessionID: Schema.String,
      callbackOwnerSessionID: Schema.String,
      kind: Schema.String,
      state: Schema.String,
      deliveryExpectation: Schema.String,
      evidence: Refs,
    }),
  ),
  reminders: Schema.Array(
    Schema.Struct({ id: Fact, ownerSessionID: Schema.String, purpose: Schema.String, state: Schema.String, evidence: Refs }),
  ),
  unresolved: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      questionOrOutcome: Schema.String,
      state: Schema.String,
      safeDefault: Schema.String,
      evidence: Refs,
    }),
  ),
  evidence: Refs,
  review: Schema.Struct({
    reviewedStateHash: Schema.String,
    reviewerEvidence: Refs,
    reviewedAt: Schema.String,
    completenessAttestation: Schema.String,
    currentThrough: Coverage,
  }),
})
export const decodeState = Schema.decodeUnknownResult(State, { onExcessProperty: "error" })

/** Sorted-key compact JSON, so equal content always hashes and renders identically. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  )

/** Review-target domain, `review.reviewedStateHash`: the state without its own review envelope. */
export const reviewTargetHash = (state: StateInfo) => Hash.sha256(canonical({ ...state, review: undefined }))

/** Receipt and checkpoint domain: the complete state, review envelope included. It lives outside the state. */
export const stateHash = (state: StateInfo) => Hash.sha256(canonical(state))

/** Deterministic checkpoint text, also the durable `Compaction.Ended` text that history and replay decode. */
export const render = (state: StateInfo, revision: number, hash: string) =>
  [`${PREFIX}version="1" revision="${revision}" sha256="${hash}">`, NOTICE, canonical(state), "</controller-state>"].join("\n")

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

const HEADER = /^<controller-state version="(\d+)" revision="(\d+)" sha256="([0-9a-f]{64})">\n/

/** The local receipt key, shared by core's checkpoint records. */
export const currentKey = (sessionID: string) => `session/state-checkpoint/${sessionID}/current`

/**
 * Strict decoder for a compaction that durable native evidence binds as core's checkpoint: its control's payload
 * names the session, revision and full state hash. Envelope-shaped text without that binding is never decoded; it is
 * ordinary summary text. A bound text that does not re-render byte for byte, or names anything else, is `false`.
 */
export const decode = (text: string, binding: { readonly sessionID: string; readonly revision: number; readonly stateHash: string }) => {
  const header = HEADER.exec(text)
  const json = text.split("\n")[2]
  if (!header || header[1] !== "1" || json === undefined) return false as const
  const decoded = decodeState(parse(json))
  if (Result.isFailure(decoded)) return false as const
  const state = decoded.success as StateInfo
  const revision = Number(header[2])
  if (stateHash(state) !== header[3] || render(state, revision, header[3]) !== text) return false as const
  if (state.sessionID !== binding.sessionID || revision !== binding.revision || header[3] !== binding.stateHash) return false as const
  return { state, revision, stateHash: header[3], coverage: state.review.currentThrough }
}
