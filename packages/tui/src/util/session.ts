// Shared pure presentation helpers now belong to the CLI task plugin package.
export * from "@kernel-oops/opencode-background-tasks/session"

import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { Locale } from "./locale"

export function contextUsage(
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  boundary?: string,
) {
  const last = lastAssistantWithUsage(messages, boundary)
  if (!last) return
  const tokens = last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return
  const model = models?.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)
  return { tokens, percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : undefined }
}

export function formatContextUsage(tokens: number, percent?: number) {
  const value = Locale.number(tokens)
  return percent === undefined ? value : `${value} (${percent}%)`
}
