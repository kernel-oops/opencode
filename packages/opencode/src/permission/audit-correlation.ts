import { createHash } from "node:crypto"

/**
 * Returns a pseudonymous, linkable audit key. It is not an anonymisation boundary.
 *
 * The v1 preimage is the UTF-8 prefix `opencode-audit-correlation-v1\0`, followed
 * by sessionID, messageID, callID, permission, and origin as ordered UTF-8
 * netstrings (`<byte-length>:<value>,`).
 */
export function auditCorrelationKey(input: {
  sessionID: string
  messageID: string
  callID: string
  permission: string
  origin: string
}) {
  const fields = [input.sessionID, input.messageID, input.callID, input.permission, input.origin]
  const preimage = Buffer.concat([
    Buffer.from("opencode-audit-correlation-v1\0", "utf8"),
    ...fields.flatMap((field) => {
      const value = Buffer.from(field, "utf8")
      return [Buffer.from(`${value.byteLength}:`, "ascii"), value, Buffer.from(",", "ascii")]
    }),
  ])
  return createHash("sha256").update(preimage).digest("hex")
}
