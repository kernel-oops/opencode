import { describe, expect, test } from "bun:test"
import { descendants, shortModelLabel } from "./model"

describe("session background", () => {
  test("saved descendants include grandchildren but not siblings", () => {
    const sessions = [
      { id: "root" },
      { id: "a", parentID: "root" },
      { id: "a1", parentID: "a" },
      { id: "b", parentID: "root" },
      { id: "x", parentID: "other" },
    ]
    expect(descendants(sessions, "root").map(({ session, depth }) => [session.id, depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["b", 0],
    ])
  })

  test("short model labels", () => {
    expect(shortModelLabel({ id: "gpt-6.1-sol-oauth", variant: "high" })).toBe("gpt-6.1-sol (high)")
    expect(shortModelLabel(undefined)).toBeUndefined()
  })
})
