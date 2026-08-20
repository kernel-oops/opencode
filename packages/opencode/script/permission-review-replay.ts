import type { PermissionReviewEvidenceSource } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import {
  CAPACITY,
  canonicalPermissionRequest,
  INSTRUCTIONS,
  streamPermissionAssessment,
  type AssessmentResult,
  type Failure,
} from "@/permission/reviewer-assessment"
import { buildPermissionReviewSnapshot, serialiseReviewInput, type EvidenceInput } from "@/permission/reviewer-input"
import { CODEX_BASE_URL, createReplayCodexModel, loadReplayOAuth, REPLAY_API_MODEL } from "@/permission/replay-oauth"

declare const REPLAY_SOURCE_COMMIT: string

const SOURCE_COMMIT = typeof REPLAY_SOURCE_COMMIT === "string" ? REPLAY_SOURCE_COMMIT : "unbuilt"
const PROTOCOL = 2
const BUILD_PROFILE = "bun_compile_no_autoload_v1"
const MAX_ROWS = 50
const MAX_LINE_BYTES = 2 * 1024 * 1024
const MAX_INPUT_BYTES = 64 * 1024 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SOURCES = new Set<PermissionReviewEvidenceSource>([
  "human",
  "developer",
  "agent",
  "instruction",
  "assistant",
  "tool",
  "child_prompt",
  "skill",
  "mcp",
  "plugin",
  "http",
  "environment",
  "summary",
])
const INPUT_KEYS = new Set([
  "session_id",
  "message_id",
  "call_id",
  "permission",
  "origin",
  "action",
  "trusted",
  "untrusted",
  "trusted_complete",
  "untrusted_complete",
  "context_safe_for_gate",
])

type Input = {
  session_id: string
  message_id: string
  call_id: string
  permission: string
  origin: string
  action: { identity: string; arguments: unknown; cwd?: string | null; complete: boolean }
  trusted: EvidenceInput[]
  untrusted: EvidenceInput[]
  trusted_complete: boolean
  untrusted_complete: boolean
  context_safe_for_gate: boolean
}

function options() {
  if (process.argv.length === 3 && process.argv[2] === "--version-json") return { version: true as const }
  const values = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index]
    const value = process.argv[index + 1]
    if (!name?.startsWith("--") || value === undefined || values.has(name)) throw new Error("invalid options")
    values.set(name, value)
  }
  if ([...values.keys()].some((name) => !["--concurrency", "--call-timeout-ms", "--overall-timeout-ms"].includes(name)))
    throw new Error("invalid options")
  const integer = (name: string, fallback: number) => {
    const value = values.has(name) ? Number(values.get(name)) : fallback
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid option")
    return value
  }
  const concurrency = integer("--concurrency", 4)
  if (concurrency > CAPACITY) throw new Error("capacity exceeded")
  return {
    version: false as const,
    concurrency,
    callTimeoutMs: integer("--call-timeout-ms", 30_000),
    overallTimeoutMs: integer("--overall-timeout-ms", 20 * 60_000),
  }
}

function evidence(value: unknown): value is EvidenceInput[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        Object.keys(item).length === 2 &&
        Object.hasOwn(item, "source") &&
        Object.hasOwn(item, "text") &&
        SOURCES.has((item as EvidenceInput).source) &&
        typeof (item as EvidenceInput).text === "string",
    )
  )
}

function input(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid row")
  if (Object.keys(value).length !== INPUT_KEYS.size || Object.keys(value).some((key) => !INPUT_KEYS.has(key)))
    throw new Error("invalid row")
  const row = value as Partial<Input>
  if (![row.session_id, row.message_id, row.call_id].every((item) => typeof item === "string" && ID.test(item)))
    throw new Error("invalid row")
  if (row.permission !== "bash" || row.origin !== "tool") throw new Error("invalid row")
  if (!row.action || typeof row.action !== "object" || row.action.identity !== "bash") throw new Error("invalid row")
  const actionKeys = Object.keys(row.action)
  if (
    !Object.hasOwn(row.action, "arguments") ||
    actionKeys.some((key) => !["identity", "arguments", "cwd", "complete"].includes(key)) ||
    ![3, 4].includes(actionKeys.length)
  )
    throw new Error("invalid row")
  if (typeof row.action.complete !== "boolean") throw new Error("invalid row")
  if (row.action.cwd !== undefined && row.action.cwd !== null && typeof row.action.cwd !== "string")
    throw new Error("invalid row")
  if (!evidence(row.trusted) || !evidence(row.untrusted)) throw new Error("invalid row")
  if (typeof row.trusted_complete !== "boolean" || typeof row.untrusted_complete !== "boolean")
    throw new Error("invalid row")
  if (typeof row.context_safe_for_gate !== "boolean") throw new Error("invalid row")
  return row as Input
}

async function rows() {
  const result: Input[] = []
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffered = ""
  let bytes = 0
  const reader = Bun.stdin.stream().getReader()
  while (true) {
    const item = await reader.read()
    if (item.done) break
    bytes += item.value.byteLength
    if (bytes > MAX_INPUT_BYTES) throw new Error("input too large")
    buffered += decoder.decode(item.value, { stream: true })
    while (true) {
      const end = buffered.indexOf("\n")
      if (end < 0) break
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("line too large")
      if (!line.trim()) continue
      if (result.length >= MAX_ROWS) throw new Error("too many rows")
      result.push(input(JSON.parse(line)))
    }
    if (Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES) throw new Error("line too large")
  }
  buffered += decoder.decode()
  if (buffered.trim()) {
    if (result.length >= MAX_ROWS || Buffer.byteLength(buffered, "utf8") > MAX_LINE_BYTES)
      throw new Error("invalid final row")
    result.push(input(JSON.parse(buffered)))
  }
  return result
}

function common(
  request: Input,
  snapshot: ReturnType<typeof buildPermissionReviewSnapshot>,
  latency: number,
  settled: boolean,
) {
  return {
    schema_version: 1,
    kind: "luna_replay_result",
    session_id: request.session_id,
    message_id: request.message_id,
    call_id: request.call_id,
    latency_ms: latency,
    settled,
    snapshot_complete: snapshot.complete,
    action_complete: snapshot.action.complete,
    trusted_complete: snapshot.trusted.complete,
    untrusted_complete: snapshot.untrusted.complete,
    context_safe_for_gate: snapshot.context_safe_for_gate,
    builder_action_omitted_items: snapshot.action.omitted_items,
    builder_action_omitted_bytes: snapshot.action.omitted_bytes,
    builder_trusted_omitted_items: snapshot.trusted.omitted_items,
    builder_trusted_omitted_bytes: snapshot.trusted.omitted_bytes,
    builder_untrusted_omitted_items: snapshot.untrusted.omitted_items,
    builder_untrusted_omitted_bytes: snapshot.untrusted.omitted_bytes,
  }
}

async function main() {
  const settings = options()
  if (settings.version) {
    if (!/^[0-9a-f]{40}$/.test(SOURCE_COMMIT)) throw new Error("unbuilt worker")
    process.stdout.write(
      JSON.stringify({
        kind: "permission_review_replay_worker",
        protocol: PROTOCOL,
        build_profile: BUILD_PROFILE,
        source_commit: SOURCE_COMMIT,
        model: REPLAY_API_MODEL,
        base_url: CODEX_BASE_URL,
      }) + "\n",
    )
    return
  }
  const requests = await rows()
  const authResult = loadReplayOAuth()
  const model = "auth" in authResult ? createReplayCodexModel(authResult.auth) : undefined
  const authFailure = "failure" in authResult ? authResult.failure : undefined
  const deadline = performance.now() + settings.overallTimeoutMs
  const active = new Set<AbortController>()
  const output: Record<string, unknown>[] = Array(requests.length)
  let next = 0
  const overallTimer = setTimeout(() => {
    for (const controller of active) controller.abort()
  }, settings.overallTimeoutMs)

  const worker = async () => {
    while (true) {
      const index = next++
      if (index >= requests.length) return
      const request = requests[index]
      const snapshot = buildPermissionReviewSnapshot({
        permission: request.permission,
        origin: request.origin,
        action: request.action,
        trusted: request.trusted,
        untrusted: request.untrusted,
        trustedComplete: request.trusted_complete,
        untrustedComplete: request.untrusted_complete,
        contextSafeForGate: request.context_safe_for_gate,
      })
      const serialised = serialiseReviewInput({ snapshot })
      const base = common(request, snapshot, 0, true)
      if (!("data" in serialised)) {
        output[index] = { ...base, failure: serialised.failure }
        continue
      }
      const canonical = canonicalPermissionRequest(serialised.data)
      const canonicalFields = {
        canonical_input: canonical,
        canonical_input_sha256: createHash("sha256").update(canonical).digest("hex"),
      }
      if (authFailure || !model) {
        output[index] = { ...base, ...canonicalFields, failure: authFailure ?? "auth" }
        continue
      }
      const remaining = Math.floor(deadline - performance.now())
      if (remaining <= 0) {
        output[index] = { ...base, ...canonicalFields, failure: "overall_timeout", settled: true }
        continue
      }
      const controller = new AbortController()
      active.add(controller)
      const started = performance.now()
      let settled = false
      const operation = streamPermissionAssessment({
        model,
        serialised: serialised.data,
        abortSignal: controller.signal,
        abort: () => controller.abort(),
        openaiOauth: true,
        openaiProvider: true,
      }).finally(() => {
        settled = true
        active.delete(controller)
      })
      const timeoutMs = Math.min(settings.callTimeoutMs, remaining)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<AssessmentResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({ failure: "timeout" })
        }, timeoutMs)
      })
      const result = await Promise.race([operation, timeout])
      if (timer) clearTimeout(timer)
      const latency = Math.round((performance.now() - started) * 1_000) / 1_000
      if (!settled) {
        const settleRemaining = Math.max(0, deadline - performance.now())
        await Promise.race([operation.then(() => undefined), Bun.sleep(settleRemaining)])
      }
      const fields = { ...common(request, snapshot, latency, settled), ...canonicalFields }
      output[index] = "failure" in result ? { ...fields, failure: result.failure } : { ...fields, ...result.assessment }
    }
  }

  try {
    await Promise.all(Array.from({ length: settings.concurrency }, worker))
  } finally {
    clearTimeout(overallTimer)
    for (const controller of active) controller.abort()
  }
  process.stdout.write(output.map((item) => JSON.stringify(item)).join("\n") + "\n")
}

try {
  await main()
} catch {
  process.stderr.write("permission replay worker failed\n")
  process.exitCode = 2
}
