// shortcut: keep the existing TUI callers local until their presentation moves to the external task plugin.
export * from "./task-session"

import type { JobInfo, ModelInfo, SessionMessageInfo } from "@opencode/client"
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

// Running jobs in a session's tree. A subagent job belongs to the child it runs.
export function ownedJobs(jobs: readonly JobInfo[], sessionID: string, parentID: (id: string) => string | undefined) {
  return jobs.filter((job) => {
    const seen = new Set<string>()
    let current: string | undefined = job.kind === "subagent" ? job.childSessionID : job.sessionID
    while (current && !seen.has(current)) {
      if (current === sessionID) return true
      seen.add(current)
      // A subagent job runs in the direct child of the session that started it.
      current =
        parentID(current) ?? (job.kind === "subagent" && current === job.childSessionID ? job.sessionID : undefined)
    }
    return false
  })
}

// A script moved to the background ends its execute call with the job's id; its first line of code names it.
export function scriptLabel(messages: readonly SessionMessageInfo[], job: JobInfo) {
  const code = messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .flatMap((part) =>
      part.type === "tool" &&
      part.name === "execute" &&
      part.state.status === "completed" &&
      part.state.metadata?.jobID === job.id &&
      typeof part.state.input.code === "string"
        ? [part.state.input.code]
        : [],
    )
    .at(-1)
  const line = code
    ?.split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  return line ?? job.title ?? "Script"
}
