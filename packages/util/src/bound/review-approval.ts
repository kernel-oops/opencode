export * as ReviewApproval from "./review-approval.js"

/** Whole human input only; callers must also reject attachments and other context parts. */
export const requestID = (text: string) => /^I approve (per_[A-Za-z0-9]+)$/.exec(text)?.[1]

/** Reserve only the command prefix or quoted command, not ordinary approval prose. */
export const commandInput = (text: string) => /^(?:I approve(?:\s*$|\s+per_)|["'`]I approve(?:\s*$|\s+per_))/.test(text.trim())

/** Display only. The permission engine binds the original values, not this masked rendering. */
export function display(value: unknown): string {
  return JSON.stringify(value, (key, item) =>
    /(?:password|passwd|secret|token|credential|authorization|private.?key|api.?key)/i.test(key)
      ? "[REDACTED]"
      : typeof item === "string"
        ? item
            .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]")
            .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
            .replace(/((?:[\w-]*(?:password|secret|token|api[_-]?key|private[_-]?key)[\w-]*)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
            .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, "://[REDACTED]@")
        : item,
    2,
  ) ?? ""
}
