import { describe, expect, test } from "bun:test"
import { subagentModelLine } from "./model"

describe("subagent model line", () => {
  test("uses catalogue display names, then falls back to ids", () => {
    const catalogue = {
      models: [{ providerID: "openai", id: "gpt-6.1-sol-oauth", name: "GPT 6.1 Sol (OAuth)" }],
      providers: [{ id: "openai", name: "OpenAI" }],
    }
    expect(
      subagentModelLine(
        { agent: "Lister", model: { providerID: "openai", id: "gpt-6.1-sol-oauth", variant: "high" } },
        catalogue,
      ),
    ).toBe("Lister · GPT 6.1 Sol (OAuth) · OpenAI · high")
    expect(subagentModelLine({ model: { providerID: "x", id: "m" } }, { models: [], providers: [] })).toBe(
      "Subagent · m · x",
    )
    expect(subagentModelLine({ agent: "build" }, catalogue)).toBeUndefined()
  })
})
