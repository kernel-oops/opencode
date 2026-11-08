export * as SessionBudgetReasoning from "./context-budget-reasoning.js"

import { AssistantMessage, type LLMRequest } from "@opencode/ai/effect"
import type { SessionMessage } from "./message.js"
import type { SessionRunnerModel } from "./runner/model.js"
import type { Schema } from "effect"

/** Primitive request-local evidence copied before hooks, never a new persisted ledger. */
export interface Evidence {
  readonly assistantID: string
  readonly responseID: string
  readonly itemID: string
  readonly ciphertext: string
  readonly namespace: string
  readonly generated: number
}

export const capture = (input: {
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly model: SessionRunnerModel.Resolved
}): ReadonlyArray<Evidence> =>
  input.messages.flatMap((message) => {
    if (
      message.type !== "assistant" ||
      message.time.completed === undefined ||
      message.error ||
      message.interruption ||
      (message.finish !== "stop" && message.finish !== "tool-calls") ||
      message.native?.nativeInterrupted ||
      message.native?.nativeSteered ||
      message.native?.nativeAmbiguous ||
      message.model.providerID !== input.model.ref.providerID ||
      message.model.id !== input.model.ref.id ||
      (message.model.variant ?? "default") !== (input.model.ref.variant ?? "default") ||
      typeof message.native?.responseId !== "string" ||
      message.native.responseId.length === 0 ||
      !message.tokens
    )
      return []
    const output = message.tokens.output
    const reasoning = message.tokens.reasoning
    const responseID = message.native.responseId
    if (
      ![output, reasoning, output + reasoning].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      output + reasoning === 0
    )
      return []
    return message.content.flatMap((part): Evidence[] => {
      if (
        part.type !== "reasoning" ||
        part.time?.completed === undefined ||
        typeof part.native?.itemId !== "string" ||
        part.native.itemId.length === 0 ||
        typeof part.native.reasoningEncryptedContent !== "string" ||
        part.native.reasoningEncryptedContent.length === 0
      )
        return []
      return [
        {
          assistantID: message.id,
          responseID,
          itemID: part.native.itemId,
          ciphertext: part.native.reasoningEncryptedContent,
          namespace: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
          generated: output + reasoning,
        },
      ]
    })
  })

/** Only the temporary counting views change. The actual provider request and its ciphertext stay untouched. */
export const counting = (request: LLMRequest, body: Schema.Json | undefined, inventory: ReadonlyArray<Evidence>) => {
  const allowed = new Map<string, Evidence>()
  const sources = new Map<string, number>()
  let valid = true
  // Only assistant messages carry replayed reasoning.
  const messages = request.messages.map((message) =>
    message.role !== "assistant"
      ? message
      : new AssistantMessage({
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "reasoning") return part
          const entries = Object.entries(part.providerMetadata ?? {})
          const encrypted = entries.filter(
            ([, metadata]) =>
              typeof metadata?.reasoningEncryptedContent === "string" && metadata.reasoningEncryptedContent.length > 0,
          )
          if (encrypted.length === 0) return part
          if (encrypted.length !== 1) {
            valid = false
            return part
          }
          const [namespace, metadata] = encrypted[0]
          const matches = inventory.filter(
            (item) =>
              item.assistantID === message.id &&
              item.namespace === namespace &&
              item.itemID === metadata.itemId &&
              item.ciphertext === metadata.reasoningEncryptedContent,
          )
          const unique = new Map(matches.map((item) => [JSON.stringify(item), item]))
          const evidence = [...unique.values()][0]
          if (unique.size !== 1 || !evidence) {
            valid = false
            return part
          }
          if (
            inventory.some(
              (item) =>
                item.itemID === evidence.itemID &&
                (item.assistantID !== evidence.assistantID ||
                  item.responseID !== evidence.responseID ||
                  item.ciphertext !== evidence.ciphertext),
            )
          ) {
            valid = false
            return part
          }
          const previous = allowed.get(evidence.itemID)
          if (
            previous &&
            (previous.assistantID !== evidence.assistantID || previous.ciphertext !== evidence.ciphertext)
          ) {
            valid = false
            return part
          }
          allowed.set(evidence.itemID, evidence)
          sources.set(evidence.assistantID, evidence.generated)
          return {
            ...part,
            providerMetadata: { ...part.providerMetadata, [namespace]: { ...metadata, reasoningEncryptedContent: "" } },
          }
        }),
      }),
  )
  const seen = new Set<string>()
  const rewrite = (value: Schema.Json): Schema.Json => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (value === null || typeof value !== "object") return value
    const record = value as Readonly<Record<string, Schema.Json>>
    if (
      record.type === "reasoning" &&
      typeof record.encrypted_content === "string" &&
      record.encrypted_content.length > 0
    ) {
      const evidence = typeof record.id === "string" ? allowed.get(record.id) : undefined
      const ordinary =
        Array.isArray(record.summary) &&
        record.summary.every(
          (part) =>
            part !== null &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            "type" in part &&
            part.type === "summary_text" &&
            "text" in part &&
            typeof part.text === "string",
        )
      if (
        !evidence ||
        evidence.ciphertext !== record.encrypted_content ||
        seen.has(evidence.itemID) ||
        !ordinary ||
        Object.keys(record).some((key) => !["type", "id", "summary", "encrypted_content"].includes(key))
      ) {
        valid = false
        return value
      }
      seen.add(evidence.itemID)
      return { ...record, encrypted_content: "" }
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, rewrite(entry)]))
  }
  return {
    request: { ...request, messages },
    body: body === undefined ? undefined : rewrite(body),
    generated: [...sources.values()].reduce((sum, value) => sum + value, 0),
    valid,
  }
}
