import type { ContentPart, LLMRequest, Message, ToolEntry } from "@opencode/ai/effect"
import type { Model } from "@opencode/schema/model"
import { Token } from "../util/token.js"

export const RESERVE_MIN = 16_000
export const RESERVE_SHARE = 0.15

/** Existing automatic-compaction safe input ceiling, including its reply reserve. */
export const calculateCeiling = (limit: Model.Info["limit"], buffer: number | string | undefined) => {
  const input = limit.input ?? 0
  const window = input > 0 ? (limit.context > 0 ? Math.min(input, limit.context) : input) : limit.context
  if (window <= 0) return Number.POSITIVE_INFINITY
  const tokens = typeof buffer === "string" ? Math.round((window * Number.parseFloat(buffer)) / 100) : buffer
  if (tokens !== undefined && tokens < window) return window - tokens
  return window - Math.max(Math.floor(window * RESERVE_SHARE), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
}

export const estimateRequest = (request: Pick<LLMRequest, "system" | "tools" | "messages">) =>
  request.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
  request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) +
  request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)

const estimateTool = (tool: ToolEntry): number => {
  if (tool.type === "tool") return Token.estimate(tool.name + tool.description + JSON.stringify(tool.inputSchema))
  return (
    Token.estimate(tool.name + (tool.description ?? "")) +
    tool.tools.reduce((sum, entry) => sum + estimateTool(entry), 0)
  )
}

export const estimateMessage = (message: Message) => message.content.reduce((sum, part) => sum + estimatePart(part), 0)

const estimatePart = (part: ContentPart): number => {
  if (part.type === "compaction") return Token.estimate(part.text ?? "")
  if (part.type === "effort") return 0
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "media") return estimateMedia(part.media.mediaType)
  if (part.type === "tool-call") return Token.estimate(part.name + (JSON.stringify(part.input) ?? ""))
  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  return Token.estimate(
    typeof part.result.value === "string" ? part.result.value : (JSON.stringify(part.result.value) ?? ""),
  )
}

const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  if (type.startsWith("image/")) return 1_500
  if (type === "application/pdf") return 2_000
  return 0
}
