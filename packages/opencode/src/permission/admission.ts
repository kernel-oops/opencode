import type { SessionV1 } from "@opencode-ai/core/v1/session"

export const ADMISSION_TEXT_BUDGET = 40 * 1024

type InputPart = {
  readonly type: string
  readonly text?: unknown
  readonly synthetic?: unknown
  readonly ignored?: unknown
}

function bytes(value: readonly string[]) {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

export function buildPermissionReviewAdmission(parts: readonly InputPart[]): SessionV1.PermissionReviewAdmission {
  const text = parts.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" && part.synthetic !== true && part.ignored !== true
      ? [part.text]
      : [],
  )
  const ordinaryTextOnly = text.length === parts.length && text.some((value) => value.length > 0)
  if (bytes(text) <= ADMISSION_TEXT_BUDGET) return { version: 1, text, complete: ordinaryTextOnly }

  const first = text[0]
  const latest = text.at(-1)
  const boundary = first === undefined ? [] : latest === undefined || latest === first ? [first] : [first, latest]
  if (bytes(boundary) <= ADMISSION_TEXT_BUDGET) return { version: 1, text: boundary, complete: false }
  if (latest !== undefined && bytes([latest]) <= ADMISSION_TEXT_BUDGET)
    return { version: 1, text: [latest], complete: false }
  if (first !== undefined && bytes([first]) <= ADMISSION_TEXT_BUDGET)
    return { version: 1, text: [first], complete: false }
  return { version: 1, text: [], complete: false }
}
