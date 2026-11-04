// KCP context is model-only, but a model can copy it into its visible reply.
export function hideKcpContext(text: string, streaming = false): string {
  const opening = "<dcp-system-reminder>"
  const closing = "</dcp-system-reminder>"
  let result = text
  for (;;) {
    const start = result.indexOf(opening)
    if (start < 0) break
    const end = result.indexOf(closing, start + opening.length)
    result = result.slice(0, start) + (end < 0 ? "" : result.slice(end + closing.length))
  }
  // Withhold incomplete markers too, so streamed text cannot briefly expose them.
  for (let length = streaming ? opening.length - 1 : 0; length > 0; length--) {
    if (result.endsWith(opening.slice(0, length))) {
      result = result.slice(0, -length)
      break
    }
  }
  result = result.replace(/(?:\s*@(?!0)(?:\d+|b\d+|blocked)@(?:[ \t]+\[[a-z]*\]?)?)+\s*$/i, "")
  result = result.replace(/@(?:[1-9]\d*|b[1-9]\d*|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?/gi, "")
  return streaming ? result.replace(/(?:\s*@(?!0)(?:\d*|b\d*|b(?:l(?:o(?:c(?:k(?:e(?:d)?)?)?)?)?)?)?@?)$/i, "") : result
}
