import type {
  PermissionReviewEvidence,
  PermissionReviewEvidenceSource,
  PermissionReviewSnapshot,
  PermissionReviewValue,
} from "@opencode-ai/plugin"
import { types } from "node:util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ADMISSION_TEXT_BUDGET } from "./admission"

const ACTION_BUDGET = 32 * 1024
const TRUSTED_BUDGET = 40 * 1024
const UNTRUSTED_BUDGET = 24 * 1024
const EVIDENCE_ITEM_BUDGET = 8 * 1024
const MAX_INPUT_BYTES = 96 * 1024
const MAX_DEPTH = 12
const MAX_NODES = 2_000
const MAX_ENTRIES = 200
const REDACTED = "[REDACTED]"

type Failure = "input" | "lossy" | "serialization" | "size"
type Serialised = { data: string } | { failure: Failure }

export type EvidenceInput = {
  source: PermissionReviewEvidenceSource
  text: string
}

export type SnapshotInput = {
  permission: string
  origin: string
  patterns?: readonly string[]
  metadata?: unknown
  cwd?: string
  arguments?: unknown
  action?: {
    identity: string
    arguments?: unknown
    cwd?: string | null
    complete: boolean
  }
  trusted: readonly EvidenceInput[]
  untrusted: readonly EvidenceInput[]
  trustedComplete?: boolean
  untrustedComplete?: boolean
  contextSafeForGate?: boolean
}

export function validPermissionReviewAdmission(value: unknown): value is SessionV1.PermissionReviewAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const admission = value as Partial<SessionV1.PermissionReviewAdmission>
  return (
    admission.version === 1 &&
    typeof admission.complete === "boolean" &&
    Array.isArray(admission.text) &&
    admission.text.length > 0 &&
    admission.text.every((text) => typeof text === "string") &&
    Buffer.byteLength(JSON.stringify(admission.text), "utf8") <= ADMISSION_TEXT_BUDGET
  )
}

export function transcriptEvidence(
  messages: readonly SessionV1.WithParts[],
  child: boolean,
  includeAdmission = true,
  sessionID?: string,
) {
  const items: EvidenceInput[] = []
  const seen = new Set<string>()
  const provenanceKnown =
    sessionID === undefined ||
    messages.every((message, index) => {
      const previous = messages[index - 1]
      if (message.info.sessionID !== sessionID || seen.has(message.info.id)) return false
      seen.add(message.info.id)
      return (
        previous === undefined ||
        message.info.time.created > previous.info.time.created ||
        (message.info.time.created === previous.info.time.created && message.info.id > previous.info.id)
      )
    })
  let complete = !child && includeAdmission && provenanceKnown
  let admitted = 0
  for (const message of messages) {
    if (message.info.summary) complete = false
    if (message.info.role === "user") {
      const record = message.info.permissionReview?.admission
      if (!child && includeAdmission && provenanceKnown && validPermissionReviewAdmission(record)) {
        admitted += 1
        for (const text of record.text) if (text) items.push({ source: "human", text })
        if (!record.complete) complete = false
      } else {
        complete = false
      }
    } else if ("permissionReview" in message.info && message.info.permissionReview !== undefined) {
      complete = false
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.text) {
        const source =
          message.info.role === "user"
            ? child
              ? ("child_prompt" as const)
              : ("plugin" as const)
            : message.info.summary
              ? ("summary" as const)
              : ("assistant" as const)
        items.push({ source, text: part.text })
        continue
      }
      if (part.type !== "tool") continue
      if (part.state.status === "completed" && part.state.output) {
        items.push({ source: "tool", text: part.state.output })
        continue
      }
      if (part.state.status === "error" && part.state.error) {
        items.push({ source: "tool", text: part.state.error })
        continue
      }
      if (part.state.status === "pending" || part.state.status === "running") complete = false
    }
  }
  if (includeAdmission && admitted === 0) complete = false
  return { items, complete }
}

type Redacted = { text: string; complete: boolean; omitted: number }

function replaceSecrets(value: string): Redacted {
  let text = value
  const before = Buffer.byteLength(value, "utf8")
  text = text.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, REDACTED)
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
  text = text.replace(/\b((?:bearer|basic)\s+)[A-Za-z0-9+/_=.-]+/gi, `$1${REDACTED}`)
  text = text.replace(
    /"([^"\\]+)"(\s*:\s*)(?:"(?:\\.|[^"\\])*"|'[^'\r\n]*'|[^\s,;&}]+)/g,
    (match, key: string, separator: string) => (credentialKey(key) ? `"${key}"${separator}"${REDACTED}"` : match),
  )
  text = text.replace(
    /'((?:\\.|[^'\\])*)'(\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/g,
    (match, key: string, separator: string) =>
      credentialKey(key.replaceAll(/\\(.)/g, "$1")) ? `'${key}'${separator}'${REDACTED}'` : match,
  )
  text = text.replace(
    /(--?([A-Za-z][\w-]*)(?:=|\s+))(?:(?:"[^"\r\n]*")|(?:'[^'\r\n]*')|[^\s,;&]+)/g,
    (match, option: string, key: string) => (credentialKey(key) ? `${option}${REDACTED}` : match),
  )
  text = text.replace(
    /\b([A-Za-z_][\w.-]*)(\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/g,
    (match, key: string, separator: string) => (credentialKey(key) ? `${key}${separator}${REDACTED}` : match),
  )
  text = text.replace(
    /'(Proxy-Authorization|Authorization|Set-Cookie|Cookie)\s*:\s*(?:\\.|[^'\\\r\n])*'|"(Proxy-Authorization|Authorization|Set-Cookie|Cookie)\s*:\s*(?:\\.|[^"\\\r\n])*"|\b(Proxy-Authorization|Authorization|Set-Cookie|Cookie)\s*:\s*[^\r\n]*/gi,
    (_match, single: string | undefined, double: string | undefined, plain: string | undefined) => {
      const name = single ?? double ?? plain
      if (single) return `'${name}: ${REDACTED}'`
      if (double) return `"${name}: ${REDACTED}"`
      return `${name}: ${REDACTED}`
    },
  )
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, REDACTED)
  if (text === value) return { text, complete: true, omitted: 0 }
  return { text, complete: false, omitted: Math.max(0, before - Buffer.byteLength(text, "utf8")) }
}

function jsonBytes(value: PermissionReviewValue) {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function truncateJSON(value: string, bytes: number): Redacted {
  const redacted = replaceSecrets(value)
  if (Buffer.byteLength(JSON.stringify(redacted.text), "utf8") <= bytes) return redacted
  const suffix = "\n[OMITTED]"
  if (Buffer.byteLength(JSON.stringify(suffix), "utf8") > bytes) {
    return {
      text: "[OMITTED]",
      complete: false,
      omitted: redacted.omitted + Buffer.byteLength(redacted.text, "utf8"),
    }
  }
  let low = 0
  let high = redacted.text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = redacted.text.slice(0, middle) + suffix
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= bytes) low = middle
    else high = middle - 1
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(redacted.text[low - 1])) low--
  const prefix = redacted.text.slice(0, low)
  return {
    text: prefix + suffix,
    complete: false,
    omitted: redacted.omitted + Buffer.byteLength(redacted.text, "utf8") - Buffer.byteLength(prefix, "utf8"),
  }
}

function credentialKey(key: string) {
  const normal = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase()
  return /(password|passphrase|secret|token|apikey|authorization|cookie|privatekey|credential|accesskey(?:id)?|sessionkey|sessiontoken|securitytoken|clientsecret|accountkey|storagekey|connectionstring|saskey|sastoken)s?$/.test(
    normal,
  )
}

function plain(value: object) {
  if (types.isProxy(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function actionValue(value: unknown, budget: number) {
  const seen = new Set<object>()
  let nodes = 0
  let complete = true
  let omittedItems = 0
  let omittedBytes = 0
  const marker = "[OMITTED]"

  const omit = (items = 1) => {
    complete = false
    omittedItems += items
    return marker
  }

  const visit = (item: unknown, depth: number, bytes: number): PermissionReviewValue => {
    nodes++
    if (nodes > MAX_NODES || depth > MAX_DEPTH || bytes < jsonBytes(marker)) return omit()
    if (item === null || typeof item === "boolean") {
      return jsonBytes(item) <= bytes ? item : omit()
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        omit()
        return marker
      }
      return jsonBytes(item) <= bytes ? item : omit()
    }
    if (typeof item === "string") {
      const safe = truncateJSON(item, bytes)
      complete &&= safe.complete
      if (!safe.complete) omittedItems++
      omittedBytes += safe.omitted
      return safe.text
    }
    if (typeof item !== "object" || types.isProxy(item) || seen.has(item)) {
      omit()
      return marker
    }
    seen.add(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) {
        seen.delete(item)
        omit()
        return marker
      }
      const descriptors = Object.getOwnPropertyDescriptors(item)
      const unsupported = Reflect.ownKeys(descriptors).filter((key) => {
        if (key === "length") return false
        if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)) return true
        return Number(key) >= item.length
      })
      if (unsupported.length > 0) omit(unsupported.length)
      const result: PermissionReviewValue[] = []
      const count = Math.min(item.length, MAX_ENTRIES)
      for (let index = 0; index < count; index++) {
        const available = bytes - jsonBytes(result) - 1
        if (available < jsonBytes(marker)) break
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !("value" in descriptor)) {
          omit()
          result.push(marker)
          continue
        }
        const child = visit(descriptor.value, depth + 1, available)
        const candidate = [...result, child]
        if (jsonBytes(candidate) > bytes) break
        result.push(child)
      }
      if (count < item.length || result.length < count) {
        omit(item.length - result.length)
      }
      seen.delete(item)
      return result
    }
    if (!plain(item)) {
      seen.delete(item)
      omit()
      return marker
    }
    const result: Record<string, PermissionReviewValue> = Object.create(null)
    const descriptors = Object.getOwnPropertyDescriptors(item)
    const unsupported = Reflect.ownKeys(descriptors).filter(
      (key) => typeof key !== "string" || !descriptors[key]?.enumerable,
    )
    if (unsupported.length > 0) omit(unsupported.length)
    const keys = Object.keys(descriptors)
      .filter((key) => descriptors[key]?.enumerable)
      .sort()
    const count = Math.min(keys.length, MAX_ENTRIES)
    for (let index = 0; index < count; index++) {
      const key = keys[index]
      const descriptor = descriptors[key]
      const safeKey = truncateJSON(key, 512)
      complete &&= safeKey.complete
      if (!safeKey.complete) omittedItems++
      omittedBytes += safeKey.omitted
      let outputKey = safeKey.text
      let collision = 0
      while (Object.hasOwn(result, outputKey)) outputKey = `${safeKey.text}#${++collision}`
      const base = jsonBytes(result)
      const overhead = Buffer.byteLength(JSON.stringify(outputKey), "utf8") + (base === 2 ? 1 : 2)
      const available = bytes - base - overhead
      if (available < jsonBytes(marker)) break
      if (!("value" in descriptor)) {
        omit()
        result[outputKey] = marker
        continue
      }
      if (credentialKey(key)) {
        omit()
        result[outputKey] = jsonBytes(REDACTED) <= available ? REDACTED : marker
        continue
      }
      const child = visit(descriptor.value, depth + 1, available)
      result[outputKey] = child
      if (jsonBytes(result) > bytes) {
        delete result[outputKey]
        break
      }
    }
    if (count < keys.length || Object.keys(result).length < count) {
      omit(keys.length - Object.keys(result).length)
    }
    seen.delete(item)
    return result
  }

  const result = visit(value, 0, budget)
  return { value: result, complete, omittedItems, omittedBytes }
}

function safeEvidence(item: EvidenceInput, trusted: boolean, budget: number) {
  const base: PermissionReviewEvidence = { source: item.source, trusted, text: "" }
  const remaining = Math.max(0, budget - Buffer.byteLength(JSON.stringify(base), "utf8"))
  const safe = truncateJSON(item.text, remaining)
  return {
    value: { ...base, text: safe.text },
    complete: safe.complete,
    omitted: safe.omitted,
  }
}

function selectTrustedEvidence(input: readonly EvidenceInput[], observedComplete: boolean) {
  const full = input.map((item) => safeEvidence(item, true, TRUSTED_BUDGET))
  const allBytes = Buffer.byteLength(JSON.stringify(full.map((item) => item.value)), "utf8")
  const selected =
    allBytes <= TRUSTED_BUDGET ? full.map((_item, index) => index) : input.length <= 1 ? [0] : [0, input.length - 1]
  const retained = new Set(selected)
  const itemBudget = Math.floor(TRUSTED_BUDGET / Math.max(1, selected.length))
  const prepared = new Map(
    selected
      .filter((index) => index < input.length)
      .map((index) => [index, allBytes <= TRUSTED_BUDGET ? full[index] : safeEvidence(input[index], true, itemBudget)]),
  )
  let omittedItems = 0
  let omittedBytes = 0
  let complete = observedComplete && input.length > 0 && allBytes <= TRUSTED_BUDGET
  for (let index = 0; index < input.length; index++) {
    const item = prepared.get(index)
    if (!retained.has(index)) {
      omittedItems++
      omittedBytes += Buffer.byteLength(input[index].text, "utf8")
      continue
    }
    if (!item) continue
    complete &&= item.complete
    omittedBytes += item.omitted
  }
  return {
    items: selected.flatMap((index) => {
      const item = prepared.get(index)
      return item ? [item.value] : []
    }),
    complete,
    omitted_items: omittedItems,
    omitted_bytes: omittedBytes,
  }
}

function selectEvidence(input: readonly EvidenceInput[], trusted: boolean, budget: number, observedComplete: boolean) {
  const selected: PermissionReviewEvidence[] = []
  let remaining = budget
  let omittedItems = 0
  let omittedBytes = 0
  let complete = observedComplete
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index]
    const safe = safeEvidence(item, trusted, EVIDENCE_ITEM_BUDGET)
    const value = safe.value
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
    if (bytes > remaining) {
      complete = false
      omittedItems++
      omittedBytes += Buffer.byteLength(item.text, "utf8")
      continue
    }
    complete &&= safe.complete
    omittedBytes += safe.omitted
    remaining -= bytes
    selected.push(value)
  }
  selected.reverse()
  return { items: selected, complete, omitted_items: omittedItems, omitted_bytes: omittedBytes }
}

export function buildPermissionReviewSnapshot(input: SnapshotInput): PermissionReviewSnapshot {
  const origin = input.origin === "tool" || input.origin === "doom_loop" ? input.origin : "unknown"
  const canonical = input.action ?? { identity: input.permission, arguments: input.arguments, complete: false as const }
  const permission = truncateJSON(input.permission, 1_024)
  const identity = truncateJSON(canonical.identity, 1_024)
  const cwd =
    canonical.cwd === undefined ? undefined : canonical.cwd === null ? undefined : truncateJSON(canonical.cwd, 2 * 1024)
  const cwdStatus = canonical.cwd === null ? "not_applicable" : canonical.cwd === undefined ? "unknown" : "exact"
  const patterns = actionValue(input.patterns ?? [], 5 * 1024)
  const metadata = actionValue(input.metadata ?? {}, 5 * 1024)
  const argumentsValue = canonical.arguments === undefined ? undefined : actionValue(canonical.arguments, 14 * 1024)
  const trustedSources = new Set<PermissionReviewEvidenceSource>(["human"])
  const misplaced = input.trusted.filter((item) => !trustedSources.has(item.source))
  const trusted = selectTrustedEvidence(
    input.trusted.filter((item) => trustedSources.has(item.source)),
    (input.trustedComplete ?? true) && misplaced.length === 0,
  )
  const untrusted = selectEvidence(
    [...input.untrusted, ...misplaced],
    false,
    UNTRUSTED_BUDGET,
    input.untrustedComplete ?? true,
  )
  const actionComplete =
    canonical.complete === true &&
    cwdStatus !== "unknown" &&
    permission.complete &&
    identity.complete &&
    (cwd?.complete ?? true) &&
    patterns.complete &&
    metadata.complete &&
    (argumentsValue?.complete ?? true)
  const omittedItems = patterns.omittedItems + metadata.omittedItems + (argumentsValue?.omittedItems ?? 0)
  const omittedBytes =
    permission.omitted +
    identity.omitted +
    (cwd?.omitted ?? 0) +
    patterns.omittedBytes +
    metadata.omittedBytes +
    (argumentsValue?.omittedBytes ?? 0)
  const snapshot: PermissionReviewSnapshot = {
    version: "1",
    context_safe_for_gate: input.contextSafeForGate === true && misplaced.length === 0,
    action: {
      identity: identity.text,
      permission: permission.text,
      origin,
      ...(cwd ? { cwd: cwd.text } : {}),
      cwd_status: cwdStatus,
      patterns: patterns.value,
      metadata: metadata.value,
      ...(argumentsValue ? { arguments: argumentsValue.value } : {}),
      complete: actionComplete,
      omitted_items: omittedItems,
      omitted_bytes: omittedBytes,
    },
    trusted,
    untrusted,
    complete: actionComplete && trusted.complete && untrusted.complete,
  }
  if (Buffer.byteLength(JSON.stringify(snapshot.action), "utf8") > ACTION_BUDGET) {
    snapshot.action.complete = false
    snapshot.complete = false
    for (const key of ["arguments", "metadata", "patterns"] as const) {
      const before = Buffer.byteLength(JSON.stringify(snapshot.action[key]), "utf8")
      snapshot.action[key] = "[OMITTED]"
      const after = Buffer.byteLength(JSON.stringify(snapshot.action[key]), "utf8")
      snapshot.action.omitted_items++
      snapshot.action.omitted_bytes += Math.max(0, before - after)
      if (Buffer.byteLength(JSON.stringify(snapshot.action), "utf8") <= ACTION_BUDGET) break
    }
  }
  return snapshot
}

export function serialiseReviewInput(input: { snapshot: PermissionReviewSnapshot }): Serialised {
  try {
    const data = JSON.stringify(input.snapshot)
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) return { failure: "size" }
    return { data }
  } catch {
    return { failure: "serialization" }
  }
}
