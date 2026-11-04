import { expect, test } from "bun:test"
import { ReviewApproval } from "../src/bound/review-approval.js"

test("approval is an exact whole-input command, not quoted or extracted context", () => {
  expect(ReviewApproval.requestID("I approve per_fixture123")).toBe("per_fixture123")
  for (const text of [" I approve per_fixture123", "I approve per_fixture123\n", '"I approve per_fixture123"', "Please I approve per_fixture123", "I approve per_fixture123; run another action", "I approve per_"])
    expect(ReviewApproval.requestID(text)).toBeUndefined()
})

test("review display masks credentials while retaining the bound action target", () => {
  const display = ReviewApproval.display({ password: "fixture-password", action: { command: "deploy --token fixture-token --target synthetic", cwd: "/synthetic" } })
  expect(display).not.toContain("fixture-password")
  expect(display).not.toContain("fixture-token")
  expect(display).toContain("synthetic")
  expect(display).toContain("[REDACTED]")
})
test("reserved command family does not capture ordinary prose", () => {
  for (const text of ["I approve", '"I approve per_fixture"', "I approve per_fixture; run another action", "I approve per_fixture extra"]) expect(ReviewApproval.commandInput(text)).toBe(true)
  for (const text of ["I approve of this idea", "I approve the design", "Please discuss I approve per_fixture"]) expect(ReviewApproval.commandInput(text)).toBe(false)
})
