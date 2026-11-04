import type { SessionMessageInfo } from "@opencode/client"

export function attemptStatus(running: boolean, messages: readonly SessionMessageInfo[], now: number) {
  if (!running) return undefined
  const latest = messages.findLast((message) => message.type === "assistant")
  if (!latest || latest.type !== "assistant") return "Active"
  if (latest.retry) return `Retrying · attempt ${latest.retry.attempt}`
  if (latest.time.completed !== undefined) return "Active"
  if (latest.content.some((part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "streaming"))) return "Tool running"
  if (latest.error) return "Active"
  const seconds = Math.max(0, Math.floor((now - latest.time.created) / 1_000))
  return `Generating · ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} this attempt`
}
