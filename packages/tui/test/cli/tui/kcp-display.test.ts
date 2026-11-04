import { expect, test } from "bun:test"
import { hideKcpContext } from "../../../src/routes/session/kcp-display"

test("hides copied KCP markers without modifying the model text", () => {
  const marker = "<dcp-system-reminder>"
  const source = `Before\n${marker}private guidance</dcp-system-reminder>\nAfter\n@123@`
  expect(hideKcpContext(source)).toBe("Before\n\nAfter")
  expect(source).toContain(marker)
  expect(source).toContain("@123@")
  expect(hideKcpContext(`Before\n${marker}partial`)).toBe("Before\n")
  expect(hideKcpContext("Before <dcp-system-rem", true)).toBe("Before ")
  expect(hideKcpContext("Before @12", true)).toBe("Before")
  expect(hideKcpContext("Email @")).toBe("Email @")
  expect(hideKcpContext("Before @123@ [hi")).toBe("Before")
  expect(hideKcpContext("Before @blocked@ [high]")).toBe("Before")
  expect(hideKcpContext("Email a@example.com and use @123@ inside text")).toBe("Email a@example.com and use  inside text")
})
