import { expect, test } from "bun:test"
import { auditCorrelationKey } from "../../src/permission/audit-correlation"

const fixture = {
  sessionID: "session_fixture",
  messageID: "message_fixture",
  callID: "call_fixture",
  permission: "bash",
  origin: "tool",
}

test("auditCorrelationKey produces the exact v1 vector deterministically", () => {
  expect(auditCorrelationKey(fixture)).toBe("f8c99009be7fd0c93fac9e9b1423fad5092e0b067a1c2119d432bb6f6dc0104c")
  expect(auditCorrelationKey({ ...fixture })).toBe(auditCorrelationKey(fixture))
})

test("auditCorrelationKey preserves tuple boundaries", () => {
  expect(auditCorrelationKey({ ...fixture, sessionID: "ab", messageID: "c" })).not.toBe(
    auditCorrelationKey({ ...fixture, sessionID: "a", messageID: "bc" }),
  )
})

test("auditCorrelationKey distinguishes permissions for one tool call", () => {
  expect(auditCorrelationKey({ ...fixture, permission: "external_directory" })).toBe(
    "281c3566d6d58b398fc46bdc19479bbc767a3f4f6716574110bf2d7ab886f8df",
  )
  expect(auditCorrelationKey({ ...fixture, permission: "external_directory" })).not.toBe(auditCorrelationKey(fixture))
})

test("auditCorrelationKey uses UTF-8 byte lengths for non-ASCII fields", () => {
  expect(
    auditCorrelationKey({
      sessionID: "session_é",
      messageID: "message_猫",
      callID: "call_😀",
      permission: "bash",
      origin: "tool",
    }),
  ).toBe("7ab5c2069b1ed552308754aa6d1a791ce57025480c72e38c28f6d4ee8f1d23b1")
})
