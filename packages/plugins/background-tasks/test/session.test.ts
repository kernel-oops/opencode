import { describe, expect, test } from "bun:test"
import { shortModelLabel, runningDescendants, sessionActive, sessionFamily, topLevelSessions } from "../src/session"

describe("util.session", () => {
  test("activity filtering retains idle ancestors and builds connectors from the visible tree", () => {
    const sessions = [
      { id: "root" },
      { id: "idle", parentID: "root" },
      { id: "running", parentID: "idle" },
      { id: "hidden", parentID: "idle" },
      { id: "other", parentID: "root" },
    ]
    expect(sessionFamily(sessions, "running", (session) => session.id === "running")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "└─ " },
    ])
    expect(sessionFamily(sessions, "root", () => false)).toEqual([])
  })
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })
})

describe("sessionActive", () => {
  const data = (running: string[], shells: string[], family: Record<string, string[]> = {}) => ({
    session: {
      status: (id: string) => (running.includes(id) ? "running" : "idle"),
      family: (id: string) => family[id] ?? [id],
    },
    shell: { listBySession: (id: string) => (shells.includes(id) ? [{ id: "sh_1" }] : []) },
  })

  test("counts a running turn, a running subagent and a background shell", () => {
    expect(sessionActive(data([], []), "ses_a")).toBe(false)
    expect(sessionActive(data(["ses_a"], []), "ses_a")).toBe(true)
    expect(sessionActive(data(["ses_child"], [], { ses_a: ["ses_a", "ses_child"] }), "ses_a")).toBe(true)
    expect(sessionActive(data([], ["ses_a"]), "ses_a")).toBe(true)
  })

  test("counts a background shell started by a subagent", () => {
    expect(sessionActive(data([], ["ses_child"], { ses_a: ["ses_a", "ses_child"] }), "ses_a")).toBe(true)
    expect(sessionActive(data([], ["ses_other"], { ses_a: ["ses_a", "ses_child"] }), "ses_a")).toBe(false)
  })
})

describe("util.session open menu and running descendants", () => {
  test("the open menu drops child sessions but keeps the one whose exact ID was typed, once", () => {
    const list = [{ id: "top-a" }, { id: "child-x", parentID: "top-a" }, { id: "top-b" }, { id: "top-a" }]
    expect(topLevelSessions(list).map((session) => session.id)).toEqual(["top-a", "top-b"])
    expect(topLevelSessions(list, "child-x").map((session) => session.id)).toEqual(["top-a", "child-x", "top-b"])
    // The same child both in the loaded list and as the looked-up match appears once.
    expect(
      topLevelSessions([...list, { id: "child-x", parentID: "top-a" }], "child-x").filter(
        (session) => session.id === "child-x",
      ),
    ).toHaveLength(1)
  })

  test("finds running descendants at any depth, but not siblings, ancestors or the session itself", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "other-root" },
      { id: "other-child", parentID: "other-root" },
    ]
    const running = new Set(["root", "grandchild", "child-b", "other-child"])
    const status = (id: string) => (running.has(id) ? "running" : "idle")
    expect(runningDescendants(sessions, "root", status).map((session) => session.id)).toEqual(["grandchild", "child-b"])
    expect(runningDescendants(sessions, "child-a", status).map((session) => session.id)).toEqual(["grandchild"])
    expect(runningDescendants(sessions, "child-b", status)).toEqual([])
  })

  test("a parent cycle in the data cannot loop forever", () => {
    const sessions = [
      { id: "a", parentID: "b" },
      { id: "b", parentID: "a" },
    ]
    expect(runningDescendants(sessions, "a", () => "running").map((session) => session.id)).toEqual(["b"])
  })

  test("a subagent's model reads as a short id and effort", () => {
    expect(shortModelLabel({ id: "gpt-6.1-sol-oauth", variant: "high" })).toBe("gpt-6.1-sol (high)")
    expect(shortModelLabel({ id: "claude-opus-5-5" })).toBe("claude-opus-5-5")
    expect(shortModelLabel(undefined)).toBeUndefined()
  })
})
