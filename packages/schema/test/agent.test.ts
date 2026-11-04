import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"

test("Agent.Color preserves configured colors at the public boundary", () => {
  const encode = Schema.encodeSync(Agent.Color)

  expect(encode("info")).toBe("info")
  expect(encode("custom-color")).toBe("custom-color")
})

test("default agents require explicit permission for independent ownership", () => {
  expect(Agent.Info.default(Agent.ID.make("fixture")).permissions).toContainEqual({
    action: "new_session", resource: "*", effect: "ask",
  })
})
