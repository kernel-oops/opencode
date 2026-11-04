import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Permission } from "../src/permission.js"

test("manual review is an optional ephemeral request discriminator and distinct reply", () => {
  const decode = Schema.decodeUnknownSync(Permission.Request)
  const ordinary = decode({ id: "per_fixture", sessionID: "ses_fixture", action: "read", resources: ["/synthetic"] })
  expect(Schema.encodeSync(Permission.Request)(ordinary)).not.toHaveProperty("review")
  const review = decode({ ...ordinary, review: { kind: "model-refusal", reason: "Synthetic model refusal" } })
  expect(Schema.encodeSync(Permission.Request)(review).review).toEqual(review.review)
  expect(Schema.decodeUnknownSync(Permission.Reply)("review_once")).toBe("review_once")
  expect(() => Schema.decodeUnknownSync(Permission.Reply)("approve_all")).toThrow()
})
