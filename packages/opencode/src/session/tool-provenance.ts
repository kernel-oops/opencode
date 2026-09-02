import { SessionV1 } from "@opencode-ai/core/v1/session"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const BUILTIN_TOOL_PROVENANCE_METADATA = "permissionReviewBuiltinTool"
export const QUESTION_COMPLETION_PROVENANCE_METADATA = "permissionReviewQuestionCompletion"

const questionCompletionKey = randomBytes(32)

type QuestionCompletion = {
  sessionID: string
  messageID: string
  callID: string
  toolID: string
  input: unknown
  answers: unknown
}

const questionCompletionPayload = (input: QuestionCompletion) =>
  JSON.stringify([input.sessionID, input.messageID, input.callID, input.toolID, input.input, input.answers])

export function signQuestionCompletion(input: QuestionCompletion) {
  try {
    return createHmac("sha256", questionCompletionKey).update(questionCompletionPayload(input)).digest("hex")
  } catch {
    return undefined
  }
}

export function verifyQuestionCompletion(part: SessionV1.ToolPart) {
  if (part.state.status !== "completed") return false
  const actual = part.metadata?.[QUESTION_COMPLETION_PROVENANCE_METADATA]
  if (typeof actual !== "string") return false
  const expected = signQuestionCompletion({
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    toolID: part.tool,
    input: part.state.input,
    answers: part.state.metadata.answers,
  })
  if (!expected) return false
  const actualBytes = Buffer.from(actual, "hex")
  const expectedBytes = Buffer.from(expected, "hex")
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function builtinToolProvenance(part: SessionV1.ToolPart) {
  const value = part.metadata?.[BUILTIN_TOOL_PROVENANCE_METADATA]
  return typeof value === "string" ? value : undefined
}
