export * as SessionContextBudget from "./context-budget.js"

import { AIError, InvalidRequestError, type LLMRequest } from "@opencode/ai/effect"
import type { Model } from "@opencode/schema/model"
import type { SessionContextBudget as BudgetSchema } from "@opencode/schema/session-context-budget"
import { calculateCeiling, estimateRequest } from "./context-size.js"
import type { SessionSchema } from "./schema.js"
import { Option, Schema } from "effect"
import { Token } from "../util/token.js"
import { SessionBudgetReasoning } from "./context-budget-reasoning.js"

// The existing estimator's margin, not a mathematical bound on provider tokenisation.
export const INPUT_MARGIN = 0.15
export const selection = (session: SessionSchema.Info) => JSON.stringify(session.model ?? null)

export interface Assessment {
  readonly raw: number
  readonly replayGenerated: number
  readonly input: number
  readonly output: number
  readonly total: number
  readonly target: number
  readonly maximum: number
  readonly inputMaximum: number
  readonly contextMaximum: number
  readonly recoverable: boolean
  readonly reason?: string
}

/** Process-local runner control: no request has been dispatched and no provider retry is permitted. */
export class TargetReached extends AIError {
  constructor(readonly assessment: Assessment) {
    super({
      reason: new InvalidRequestError({
        parameter: "contextBudget.target",
        message: "Context budget target reached before dispatch",
      }),
    })
  }
}

/** Recounts the complete representation; measured provider-only history anchors are deliberately not reused. */
export const assess = (
  policy: BudgetSchema.Policy,
  request: LLMRequest,
  limit: Model.Info["limit"],
  wire?: string,
  reasoning: ReadonlyArray<SessionBudgetReasoning.Evidence> = [],
): Assessment => {
  try {
    return measure(policy, request, limit, wire, reasoning)
  } catch {
    return {
      raw: 0,
      replayGenerated: 0,
      input: 0,
      output: 0,
      total: 0,
      target: policy.target,
      maximum: policy.maximum,
      inputMaximum: 0,
      contextMaximum: Math.max(0, limit.context),
      recoverable: false,
      reason: "Request size is not representable",
    }
  }
}

const measure = (
  policy: BudgetSchema.Policy,
  request: LLMRequest,
  limit: Model.Info["limit"],
  wire?: string,
  reasoning: ReadonlyArray<SessionBudgetReasoning.Evidence> = [],
): Assessment => {
  const decoded = wire === undefined ? undefined : Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(wire)
  const body = decoded && Option.isSome(decoded) ? decoded.value : undefined
  const output = wire === undefined ? request.maxTokens : outputReserve(body)
  const counting = SessionBudgetReasoning.counting(request, body, reasoning)
  const wireEstimate =
    wire === undefined || body === undefined
      ? 0
      : Token.estimate(JSON.stringify(counting.body)) +
        Math.max(0, Token.estimate(wire) - Token.estimate(JSON.stringify(body)))
  const raw = Math.max(estimateRequest(counting.request), wireEstimate) + counting.generated
  const input = Math.ceil(raw * (1 + INPUT_MARGIN))
  const reserve = output !== undefined && Number.isSafeInteger(output) && output > 0 ? output : 0
  const inputMaximum = calculateCeiling(limit, undefined)
  const contextMaximum = limit.context
  const maximum = Math.min(policy.maximum, limit.context > 0 ? limit.context : policy.maximum)
  const total = input + reserve
  const unknown =
    !Number.isFinite(raw) ||
    !Number.isSafeInteger(total) ||
    request.messages.some((message) =>
      message.content.some(
        (part) =>
          (part.type === "tool-call" && !Schema.is(Schema.Json)(part.input)) ||
          (part.type === "tool-result" && !Schema.is(Schema.Json)(part.result.value)),
      ),
    )
      ? "Request size is not representable"
      : limit.context <= 0 || limit.output <= 0 || !Number.isFinite(inputMaximum)
        ? "Resolved model limits are unknown"
        : reserve === 0
          ? "The requested output reserve is unknown"
          : reserve > limit.output
            ? "Requested output exceeds the resolved model output limit"
            : !counting.valid
              ? "Encrypted reasoning has no matching completed source usage"
              : counting.request.messages.some((message) =>
                    message.content.some(
                      (part) =>
                        part.type === "media" ||
                        part.type === "compaction" ||
                        (part.type === "tool-result" &&
                          part.result.type === "content" &&
                          part.result.value.some((item) => item.type !== "text")) ||
                        (part.type === "reasoning" && (part.encrypted !== undefined || opaque(part.providerMetadata))),
                    ),
                  )
                ? "Media or opaque provider context has no trustworthy local size"
                : request.tools.some((tool) => unrepresentedTool(tool))
                  ? "Hosted tool expansion has no trustworthy local size"
                  : request.providerOptions && opaque(request.providerOptions)
                    ? "Provider options contain unrepresented context"
                    : wire !== undefined && (body === undefined || opaque(counting.body))
                      ? "Outbound body contains unknown or unrepresented context"
                      : undefined
  const reason =
    unknown ??
    (input > inputMaximum
      ? "Estimated input exceeds the resolved model safe input ceiling"
      : total > maximum
        ? "Estimated total exceeds the session or resolved model context ceiling"
        : undefined)
  return {
    raw,
    replayGenerated: counting.generated,
    input,
    output: reserve,
    total,
    target: Math.min(policy.target, maximum, inputMaximum + reserve),
    maximum,
    inputMaximum,
    contextMaximum,
    recoverable: unknown === undefined,
    reason,
  }
}

export const error = (reason: string) =>
  new AIError({
    reason: new InvalidRequestError({ parameter: "contextBudget", message: `Context budget blocked: ${reason}` }),
  })
export const isBlocked = (
  error: unknown,
): error is AIError & { readonly reason: InvalidRequestError & { readonly parameter: "contextBudget" } } =>
  error instanceof AIError && error.reason._tag === "InvalidRequest" && error.reason.parameter === "contextBudget"

/** A session's own ordinary arrivals never re-arm an attempted compaction. */
export const shouldCompact = (assessment: Assessment, state: BudgetSchema.State | undefined, binding: string) =>
  assessment.recoverable && assessment.total >= assessment.target && state?.attempted?.binding !== binding

const outputReserve = (body: Schema.Json | undefined): number | undefined => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return
  const record = body as Readonly<Record<string, Schema.Json>>
  const reserves: number[] = []
  for (const key of ["max_output_tokens", "max_completion_tokens", "max_tokens", "maxOutputTokens"] as const) {
    if (!(key in record)) continue
    if (typeof record[key] !== "number") return
    reserves.push(record[key])
  }
  if ("generationConfig" in record) {
    const reserve = outputReserve(record.generationConfig)
    if (reserve === undefined) return
    reserves.push(reserve)
  }
  return reserves.length ? Math.max(...reserves) : undefined
}

// These reference provider-owned input which the text estimator cannot reconstruct. Schemas and user text
// are not scanned as protocol objects: a schema property or a quotation is not a hosted operation.
const opaque = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some(opaque)
  const record = value as Record<string, unknown>
  if (
    record.previous_response_id ||
    record.conversation ||
    record.encrypted_content ||
    record.reasoningEncryptedContent ||
    record.file_id ||
    record.image_url
  )
    return true
  if (
    [
      "inlineData",
      "fileData",
      "inline_data",
      "file_data",
      "googleSearch",
      "google_search",
      "codeExecution",
      "code_execution",
      "urlContext",
    ].some((key) => key in record)
  )
    return true
  if (
    typeof record.type === "string" &&
    ![
      "text",
      "input_text",
      "output_text",
      "summary_text",
      "message",
      "function",
      "function_call",
      "function_call_output",
      "tool_use",
      "tool_result",
      "thinking",
      "reasoning",
      "refusal",
      "namespace",
      "response.create",
    ].includes(record.type)
  )
    return true
  return Object.entries(record).some(
    ([key, entry]) =>
      ![
        "parameters",
        "input_schema",
        "schema",
        "properties",
        "text",
        "description",
        "cache_control",
        "response_format",
        ...(record.type === "tool_use" ? ["input"] : []),
      ].includes(key) && opaque(entry),
  )
}

const unrepresentedTool = (tool: LLMRequest["tools"][number]): boolean =>
  tool.type === "namespace"
    ? tool.tools.some(unrepresentedTool)
    : tool.native !== undefined && Object.keys(tool.native).length > 0
