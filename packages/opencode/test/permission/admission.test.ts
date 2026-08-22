import { describe, expect, test } from "bun:test"
import { ADMISSION_TEXT_BUDGET, buildPermissionReviewAdmission } from "../../src/permission/admission"

describe("permission review prompt admission", () => {
  test("captures exact direct plain text", () => {
    expect(buildPermissionReviewAdmission([{ type: "text", text: "run the focused tests" }])).toEqual({
      version: 1,
      text: ["run the focused tests"],
      complete: true,
    })
  })

  test("fails closed for synthetic, ignored, attachment, agent, file, media, MCP and data parts", () => {
    const cases = [
      [
        { type: "text", text: "ordinary" },
        { type: "text", text: "reminder", synthetic: true },
      ],
      [
        { type: "text", text: "ordinary" },
        { type: "text", text: "ignored", ignored: true },
      ],
      [
        { type: "text", text: "ordinary" },
        { type: "file", url: "file:///tmp/a" },
      ],
      [
        { type: "text", text: "ordinary" },
        { type: "file", url: "data:text/plain,content" },
      ],
      [
        { type: "text", text: "ordinary" },
        { type: "file", url: "mcp://server/resource" },
      ],
      [
        { type: "text", text: "ordinary" },
        { type: "file", mime: "image/png" },
      ],
      [
        { type: "text", text: "ordinary" },
        { type: "agent", name: "build" },
      ],
    ]
    for (const parts of cases) {
      const result = buildPermissionReviewAdmission(parts)
      expect(result.text).toEqual(["ordinary"])
      expect(result.complete).toBe(false)
    }
  })

  test("retains exact initial and latest conflict when oversized", () => {
    const initial = `initial:${"a".repeat(15_000)}`
    const middle = `middle:${"b".repeat(15_000)}`
    const latest = `later conflict: do not run:${"c".repeat(15_000)}`
    const result = buildPermissionReviewAdmission([
      { type: "text", text: initial },
      { type: "text", text: middle },
      { type: "text", text: latest },
    ])

    expect(result).toEqual({ version: 1, text: [initial, latest], complete: false })
    expect(Buffer.byteLength(JSON.stringify(result.text), "utf8")).toBeLessThanOrEqual(ADMISSION_TEXT_BUDGET)
  })
})
