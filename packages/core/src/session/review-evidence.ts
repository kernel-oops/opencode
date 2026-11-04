export * as SessionReviewEvidence from "./review-evidence.js"

import { DateTime, Effect } from "effect"
import type {
  ReviewEvidenceMessage,
  ReviewEvidenceOrigin,
  ReviewEvidenceRelation,
  ReviewEvidenceRequest,
  ReviewEvidenceResult,
  ReviewEvidenceSession,
} from "@opencode/plugin/review-evidence"
import type { Database } from "../database/database.js"
import type { Session } from "../session.js"
import { SessionDelegation } from "./delegation.js"
import { SessionMessage } from "./message.js"
import type { SessionStored } from "./stored.js"
import { SessionSchema } from "./schema.js"

type DB = Database.Interface["db"]

/** Bounds for one evidence request. The reviewer separately bounds requests, total bytes and time. */
export const SCAN_MESSAGES = 120
export const OTHER_SESSIONS = 6
export const PAGE_MESSAGES = 40
export const MAX_MATCHES = 24
export const MESSAGE_CHARS = 1_500
export const MATCH_CHARS = 600
export const RESPONSE_CHARS = 14_000

// Cross-session frames (the opencode-meta send_message frame and its digest of held messages) arrive as user
// messages but are written by other agents; they are never current human instructions.
const CROSS_SESSION_PREFIXES = ["[cross-session message from ", "[cross-session digest: "]
const crossSession = (text: string | undefined) =>
  text !== undefined && CROSS_SESSION_PREFIXES.some((prefix) => text.startsWith(prefix))
const SESSION_ID = /^ses[A-Za-z0-9_-]{1,96}$/
const MESSAGE_ID = /^msg_[A-Za-z0-9_-]{1,96}$/

/** Existing normal Session services and the private delegation proof; nothing else is read. */
export interface Sources {
  readonly proof: (
    subject: SessionSchema.ID,
  ) => Effect.Effect<{ readonly root?: SessionSchema.ID; readonly family: ReadonlyArray<SessionSchema.ID> }>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined, unknown>
  readonly list: (input: {
    readonly project: SessionSchema.Info["projectID"]
    readonly search?: string
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<SessionSchema.Info>, unknown>
  /** Newest first, strictly older than `before` when given. */
  readonly messages: (input: {
    readonly sessionID: SessionSchema.ID
    readonly limit: number
    readonly before?: SessionMessage.ID
  }) => Effect.Effect<ReadonlyArray<SessionMessage.Info>, unknown>
  readonly message: (input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Info | undefined, unknown>
}

// An incomplete proof is an ordinary "root unknown" answer. Defects and interruption are not caught here: a
// corrupt or cancelled proof read fails the request rather than becoming a result with fabricated trust.
export const sources = (db: DB, sessions: Session.Interface): Sources => ({
  proof: (subject) =>
    SessionDelegation.authorityProof(db, subject).pipe(
      Effect.map((proof) =>
        proof.complete
          ? {
              root: proof.sessionID,
              family: proof.ancestry.map((item) => SessionSchema.ID.make(item.authority.id)),
            }
          : { family: [] },
      ),
    ),
  get: (sessionID) =>
    sessions.get(sessionID).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined))),
  list: (input) =>
    sessions
      .list({ project: input.project, limit: input.limit, ...(input.search ? { search: input.search } : {}) })
      .pipe(Effect.map((result) => result.data)),
  messages: (input) =>
    sessions.messages({
      sessionID: input.sessionID,
      limit: input.limit,
      order: "desc",
      ...(input.before ? { cursor: { id: input.before, direction: "next" as const } } : {}),
    }),
  message: (input) => sessions.message(input),
})

// Narrow masking of obvious credentials in visible text. It is deliberately simple and best-effort: excerpts are
// also kept short so that an undetected secret has little room to travel. It always runs on the whole text
// before any excerpt or match offset is chosen, so clipping can never start inside an unmasked secret.
const MASKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, "[redacted private key]"],
  [/\b((?:proxy-)?authorization|x-api-key|api[-_]?key|cookie|set-cookie)(\s*[:=]\s*)[^\n]+/gi, "$1$2[redacted]"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [
    /\b(password|passwd|passphrase|secret|token|access[-_]?key|private[-_]?key|client[-_]?secret)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi,
    "$1$2[redacted]",
  ],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [/([?&#][a-z0-9_.-]*(?:token|key|secret|sig|signature|password|auth|credential)[a-z0-9_.-]*=)[^&\s#]+/gi, "$1[redacted]"],
  [
    /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g,
    "[redacted]",
  ],
  // Long opaque mixed-case-and-digit blobs (tokens, keys); plain hex digests and words are left alone.
  [
    /\b(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}/g,
    "[redacted]",
  ],
]

export const mask = (text: string) =>
  MASKS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)

/** `text` must already be masked; `around` is an offset into that masked text. */
const clip = (text: string, limit: number, around?: number) => {
  if (text.length <= limit) return { text, truncated: false }
  const start = around === undefined ? 0 : Math.max(0, Math.min(text.length - limit, around - Math.floor(limit / 3)))
  return {
    text: (start > 0 ? "…" : "") + text.slice(start, start + limit) + (start + limit < text.length ? "…" : ""),
    truncated: true,
  }
}

const millis = (time: DateTime.Utc | undefined) => (time === undefined ? undefined : DateTime.toEpochMillis(time))

/** Masked visible text only: never reasoning, tool input/output, shell command/output, files or provider state. */
const visibleText = (message: SessionMessage.Info): string | undefined => {
  const raw = (() => {
    switch (message.type) {
      case "user":
      case "synthetic":
        return message.text
      case "assistant":
        return message.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n")
      case "compaction":
        return message.status === "failed" ? undefined : message.summary
      default:
        return undefined
    }
  })()
  return raw ? mask(raw) : undefined
}

export const originOf = (message: SessionMessage.Info | SessionStored.User, rootHuman: boolean): ReviewEvidenceOrigin => {
  switch (message.type) {
    case "user":
      if (crossSession(message.text)) return "cross_session"
      return rootHuman ? "root_human" : "agent_user"
    case "synthetic":
      return "synthetic"
    case "assistant":
      return "assistant"
    case "shell":
      return "shell"
    case "compaction":
      return "compaction"
    case "idle":
      return "idle"
    default:
      return "other"
  }
}

const project = (
  message: SessionMessage.Info,
  sessionID: SessionSchema.ID,
  isRoot: boolean,
  limit: number,
  text = visibleText(message),
  around?: number,
): ReviewEvidenceMessage => {
  const clipped = text === undefined ? undefined : clip(text, limit, around)
  const tools =
    message.type === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "tool"
            ? [
                {
                  name: part.name.slice(0, 80),
                  status: part.state.status,
                  ...(part.executed === undefined ? {} : { executed: part.executed }),
                  ...(part.time.completed ? { completed: millis(part.time.completed) } : {}),
                },
              ]
            : [],
        )
      : []
  return {
    id: message.id,
    sessionID,
    type: message.type,
    origin: originOf(message, isRoot),
    time: DateTime.toEpochMillis(message.time.created),
    ...(clipped ? { text: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) } : {}),
    ...(tools.length > 0 ? { tools: tools.slice(0, 12) } : {}),
    ...(message.type === "shell"
      ? { shell: { status: message.status, ...(message.exit === undefined ? {} : { exit: message.exit }) } }
      : {}),
    ...(message.type === "idle" ? { outcome: message.outcome } : {}),
  }
}

const withPreceding = (item: ReviewEvidenceMessage, preceding: SessionMessage.Info | undefined) => {
  if (item.origin !== "root_human" || preceding?.type !== "assistant") return item
  const text = visibleText(preceding)
  if (!text) return item
  const clipped = clip(text, MESSAGE_CHARS)
  return {
    ...item,
    precedingAssistant: { id: preceding.id, text: clipped.text, ...(clipped.truncated ? { truncated: true } : {}) },
  }
}

const terms = (query: string) =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.\-/]+/u)
        .filter((term) => term.length >= 2),
    ),
  ].slice(0, 8)

const failure = (
  error: "invalid_request" | "not_found" | "out_of_scope" | "unavailable",
  note: string,
): ReviewEvidenceResult => ({ ok: false, error, limitations: [note] })

/**
 * Answers one bounded read request for the fixed permission subject. An ordinary failed read becomes a stated
 * limitation, not an error the caller must turn into a refusal. Interruption and defects propagate unchanged.
 */
export const review = Effect.fn("SessionReviewEvidence.review")(function* (
  source: Sources,
  input: { readonly sessionID: string; readonly request: ReviewEvidenceRequest },
) {
  const request = input.request as Partial<Record<string, unknown>> & { type?: unknown }
  if (!SESSION_ID.test(input.sessionID)) return failure("invalid_request", "invalid subject session")
  const subjectID = SessionSchema.ID.make(input.sessionID)
  const limitations: string[] = []
  // Typed read failures only; `Effect.catch` leaves defects and interruption to propagate.
  const quiet = <A>(effect: Effect.Effect<A, unknown>, fallback: A, note: string) =>
    effect.pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          limitations.push(note)
          return fallback
        }),
      ),
    )

  const subject = yield* quiet(source.get(subjectID), undefined, "subject session unavailable")
  if (!subject) return failure("not_found", "subject session not found")
  const proof = yield* source.proof(subjectID)
  const root = proof.root
  if (!root) limitations.push("root provenance incomplete: no message is labelled as a current human instruction")
  const family = new Map<string, ReviewEvidenceRelation>()
  if (root) family.set(root, "root")
  for (const id of proof.family) if (!family.has(id)) family.set(id, id === subjectID ? "subject" : "ancestor")
  if (!family.has(subjectID)) family.set(subjectID, "subject")

  const resolve = Effect.fnUntraced(function* (id: unknown) {
    if (typeof id !== "string" || !SESSION_ID.test(id)) return undefined
    const sessionID = SessionSchema.ID.make(id)
    const info =
      sessionID === subjectID ? subject : yield* quiet(source.get(sessionID), undefined, `session ${id} unavailable`)
    if (!info) return undefined
    const relation = family.get(sessionID) ?? (info.projectID === subject.projectID ? "same_project" : undefined)
    return relation ? { info, relation } : ("out_of_scope" as const)
  })
  const describe = (
    info: SessionSchema.Info,
    relation: ReviewEvidenceRelation,
    extra: { scanned?: number; next?: string } = {},
  ): ReviewEvidenceSession => ({
    id: info.id,
    ...(info.title ? { title: mask(info.title).slice(0, 200) } : {}),
    relation,
    updated: DateTime.toEpochMillis(info.time.updated),
    ...extra,
  })
  // One response budget; callers stop *before* an item that does not fit, so cursors only pass delivered rows.
  let used = 0
  const fits = (item: ReviewEvidenceMessage) => {
    const size = JSON.stringify(item).length
    if (used + size > RESPONSE_CHARS) return false
    used += size
    return true
  }
  const ok = (sessions: ReviewEvidenceSession[], messages: ReviewEvidenceMessage[]): ReviewEvidenceResult => ({
    ok: true,
    rootComplete: root !== undefined,
    ...(root ? { rootSessionID: root } : {}),
    sessions,
    messages,
    limitations,
  })
  const cursorOf = (value: unknown) =>
    typeof value === "string" && MESSAGE_ID.test(value) ? SessionMessage.ID.make(value) : undefined

  if (request.type === "message") {
    const target = yield* resolve(request.sessionID)
    if (target === "out_of_scope") return failure("out_of_scope", "session is outside the subject's project")
    if (!target) return failure("not_found", "session not found")
    const messageID = cursorOf(request.messageID)
    if (!messageID) return failure("invalid_request", "invalid message ID")
    const found = yield* quiet(
      source.message({ sessionID: target.info.id, messageID }),
      undefined,
      "message unavailable",
    )
    if (!found) return failure("not_found", "message not found in that session")
    const item = project(found, target.info.id, target.info.id === root, MESSAGE_CHARS)
    const preceding =
      item.origin === "root_human"
        ? (yield* quiet(
            source.messages({ sessionID: target.info.id, limit: 1, before: messageID }),
            [],
            "preceding message unavailable",
          ))[0]
        : undefined
    return ok([describe(target.info, target.relation)], [withPreceding(item, preceding)])
  }

  if (request.type === "page") {
    const target = yield* resolve(request.sessionID)
    if (target === "out_of_scope") return failure("out_of_scope", "session is outside the subject's project")
    if (!target) return failure("not_found", "session not found")
    const before = cursorOf(request.cursor)
    // One extra row binds the oldest root-human answer on the page to its predecessor.
    const rows = yield* quiet(
      source.messages({ sessionID: target.info.id, limit: PAGE_MESSAGES + 1, ...(before ? { before } : {}) }),
      [],
      "page unavailable",
    )
    const isRoot = target.info.id === root
    // Newest rows that fit, presented oldest first; the cursor is older than the oldest row actually returned.
    const items: ReviewEvidenceMessage[] = []
    for (const [index, message] of rows.slice(0, PAGE_MESSAGES).entries()) {
      const item = withPreceding(project(message, target.info.id, isRoot, MESSAGE_CHARS), rows[index + 1])
      // The newest row is always returned (one projection is far below the bound), so a page always progresses.
      if (!fits(item) && items.length > 0) break
      items.push(item)
    }
    const next = rows.length > items.length ? items[items.length - 1]?.id : undefined
    if (next && items.length < Math.min(rows.length, PAGE_MESSAGES))
      limitations.push("page shortened to the response bound; continue with the next cursor")
    return ok([describe(target.info, target.relation, next ? { next } : {})], items.toReversed())
  }

  if (request.type !== "search" || typeof request.query !== "string")
    return failure("invalid_request", "request type must be search, page or message")
  const words = terms(request.query.slice(0, 200))
  if (words.length === 0) return failure("invalid_request", "search query has no usable terms")
  const needed = Math.max(1, Math.ceil(words.length / 2))

  const candidates: Array<{ info: SessionSchema.Info; relation: ReviewEvidenceRelation; before?: SessionMessage.ID }> =
    []
  if (request.sessionID !== undefined) {
    const target = yield* resolve(request.sessionID)
    if (target === "out_of_scope") return failure("out_of_scope", "session is outside the subject's project")
    if (!target) return failure("not_found", "session not found")
    candidates.push({ ...target, before: cursorOf(request.cursor) })
  } else {
    for (const [id, relation] of family) {
      const info =
        id === subjectID
          ? subject
          : yield* quiet(source.get(SessionSchema.ID.make(id)), undefined, `session ${id} unavailable`)
      if (info) candidates.push({ info, relation })
    }
    const longest = words.toSorted((a, b) => b.length - a.length)[0]
    const titled = yield* quiet(
      source.list({ project: subject.projectID, search: longest, limit: OTHER_SESSIONS }),
      [],
      "same-project title search unavailable",
    )
    const recent = yield* quiet(
      source.list({ project: subject.projectID, limit: OTHER_SESSIONS * 2 }),
      [],
      "same-project recent sessions unavailable",
    )
    const others = [...titled, ...recent]
      .filter((info, index, all) => !family.has(info.id) && all.findIndex((x) => x.id === info.id) === index)
      .slice(0, OTHER_SESSIONS)
    for (const info of others) candidates.push({ info, relation: "same_project" })
    limitations.push(
      `search is bounded: ${SCAN_MESSAGES} most recent messages per session, task family plus at most ${OTHER_SESSIONS} other same-project sessions; use next cursors or page for older history`,
    )
  }

  const sessions: ReviewEvidenceSession[] = []
  const matches: ReviewEvidenceMessage[] = []
  let stopped = false
  for (const candidate of candidates) {
    if (stopped) {
      // Not scanned at all: search again with this sessionID (and its earlier cursor, if any).
      sessions.push(
        describe(candidate.info, candidate.relation, {
          scanned: 0,
          ...(candidate.before ? { next: candidate.before } : {}),
        }),
      )
      continue
    }
    const rows = yield* quiet(
      source.messages({
        sessionID: candidate.info.id,
        limit: SCAN_MESSAGES,
        ...(candidate.before ? { before: candidate.before } : {}),
      }),
      [],
      `messages of ${candidate.info.id} unavailable`,
    )
    const isRoot = candidate.info.id === root
    // `consumed` rows have been fully examined and any match among them delivered.
    let consumed = 0
    for (const [index, message] of rows.entries()) {
      const text = visibleText(message)
      const haystack = (text ?? "").toLowerCase()
      const hits = words.filter((word) => haystack.includes(word))
      if (hits.length >= needed) {
        const item = withPreceding(
          project(message, candidate.info.id, isRoot, MATCH_CHARS, text, haystack.indexOf(hits[0]!)),
          rows[index + 1],
        )
        if (!fits(item)) {
          stopped = true
          break
        }
        matches.push(item)
      }
      consumed = index + 1
      if (matches.length >= MAX_MATCHES) {
        stopped = true
        break
      }
    }
    const more = consumed < rows.length || rows.length === SCAN_MESSAGES
    const next = more ? (consumed > 0 ? rows[consumed - 1]?.id : candidate.before) : undefined
    sessions.push(describe(candidate.info, candidate.relation, { scanned: consumed, ...(next ? { next } : {}) }))
  }
  if (stopped)
    limitations.push(
      `stopped at the match or response bound; sessions with scanned below their size or a next cursor have unexamined messages: search again with that sessionID and cursor`,
    )
  return ok(sessions, matches)
})
