/**
 * Read-only, bounded session evidence for the permission reviewer.
 *
 * The subject session is fixed by the permission pipeline; a request only selects what to read within the
 * subject's proven task family and native project. It carries no action, reply, path, URL, SQL or tool fields,
 * and nothing returned here is an approval: only actual root-human text in the proven root is labelled
 * `root_human`, and even that is context for the reviewer's judgement, not a permission grant.
 */
export type ReviewEvidenceRequest =
  | { readonly type: "search"; readonly query: string; readonly sessionID?: string; readonly cursor?: string }
  | { readonly type: "page"; readonly sessionID: string; readonly cursor?: string }
  | { readonly type: "message"; readonly sessionID: string; readonly messageID: string }

export type ReviewEvidenceRelation = "root" | "subject" | "ancestor" | "same_project"

/** `root_human` is only ever set for a user message in the proven root that is not a cross-session frame. */
export type ReviewEvidenceOrigin =
  | "root_human"
  | "agent_user"
  | "cross_session"
  | "synthetic"
  | "assistant"
  | "shell"
  | "compaction"
  | "idle"
  | "other"

export interface ReviewEvidenceTool {
  readonly name: string
  readonly status: string
  readonly executed?: boolean
  readonly completed?: number
}

export interface ReviewEvidenceMessage {
  readonly id: string
  readonly sessionID: string
  readonly type: string
  readonly origin: ReviewEvidenceOrigin
  readonly time: number
  /** Bounded, masked visible text. Masking is narrow and best-effort, not a guarantee. */
  readonly text?: string
  readonly truncated?: boolean
  readonly tools?: ReadonlyArray<ReviewEvidenceTool>
  readonly shell?: { readonly status: string; readonly exit?: number }
  readonly outcome?: string
  /** For a `root_human` message: the immediately preceding assistant text it may be answering. */
  readonly precedingAssistant?: { readonly id: string; readonly text: string; readonly truncated?: boolean }
}

export interface ReviewEvidenceSession {
  readonly id: string
  readonly title?: string
  readonly relation: ReviewEvidenceRelation
  readonly updated: number
  /** Messages examined in this response (search only). */
  readonly scanned?: number
  /** Cursor for older messages in this session when the bounded scan or page stopped early. */
  readonly next?: string
}

export type ReviewEvidenceResult =
  | {
      readonly ok: true
      readonly rootComplete: boolean
      readonly rootSessionID?: string
      readonly sessions: ReadonlyArray<ReviewEvidenceSession>
      readonly messages: ReadonlyArray<ReviewEvidenceMessage>
      /** Honest notes about bounded scans, unavailable reads or truncation; never "no history exists". */
      readonly limitations: ReadonlyArray<string>
    }
  | {
      readonly ok: false
      readonly error: "invalid_request" | "not_found" | "out_of_scope" | "unavailable"
      readonly limitations: ReadonlyArray<string>
    }
