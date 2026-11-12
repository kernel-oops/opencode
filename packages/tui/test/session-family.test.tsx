import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

test("a cold grandchild route hydrates its whole family with the sidebar hidden", async () => {
  const session = (id: string, title: string, parentID?: string) => ({
    id,
    title,
    parentID,
    agent: "build",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  })
  const sessions = [
    session("root", "Controller"),
    session("child", "Nested owner", "root"),
    session("grand", "Nested worker", "child"),
    session("sibling", "Sibling worker", "root"),
  ]
  const loaded: string[] = []
  await using app = await createAppFixture({
    width: 48,
    height: 24,
    args: { sessionID: "grand" },
    config: { animations: false, session: { sidebar: "hide" }, tabs: { enabled: false } },
    fetch: (url) => {
      if (url.pathname === "/api/session/active") {
        return json({ data: { grand: { type: "running" }, sibling: { type: "running" } } })
      }
      if (url.pathname === "/api/session") {
        const parent = url.searchParams.get("parentID")
        if (parent) loaded.push(`children:${parent}`)
        return json({
          data: parent ? sessions.filter((session) => session.parentID === parent) : [sessions[2]],
          cursor: {},
        })
      }
      const id = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1]
      if (id) {
        loaded.push(id)
        return json({ data: sessions.find((session) => session.id === id) })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) {
        return json({ data: [], cursor: {} })
      }
    },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Nested owner") && frame.includes("Sibling worker"))
  const frame = app.captureCharFrame()
  expect(frame).toContain("└─ Build: Nested worker")
  expect(frame.indexOf("Nested owner")).toBeLessThan(frame.indexOf("Nested worker"))
  expect(loaded).toContain("child")
  expect(loaded).toContain("root")
  expect(loaded).toContain("children:root")
})

test("a root route reads its family's pending requests once per location, not once per member", async () => {
  const session = (id: string, parentID?: string) => ({
    id,
    title: id,
    parentID,
    agent: "build",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  })
  const sessions = [session("root"), ...Array.from({ length: 30 }, (_, i) => session(`worker${i}`, "root"))]
  const permission = { id: "per_family", sessionID: "worker7", action: "shell", resources: ["echo family-fixture"] }
  const requests: string[] = []
  await using app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID: "root" },
    config: { animations: false, tabs: { enabled: false } },
    fetch: (url) => {
      requests.push(url.pathname)
      if (url.pathname === "/api/session") {
        const parent = url.searchParams.get("parentID")
        return json({ data: sessions.filter((session) => session.parentID === (parent ?? undefined)), cursor: {} })
      }
      if (url.pathname === "/api/permission/request") return json({ location: { directory }, data: [permission] })
      const id = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1]
      if (id) return json({ data: sessions.find((session) => session.id === id) })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission|form)$/.test(url.pathname)) {
        return json({ data: [], cursor: {} })
      }
    },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Permission required"))
  expect(requests.filter((path) => /^\/api\/session\/worker\d+\/(permission|form)$/.test(path))).toEqual([])
  expect(requests.filter((path) => path === "/api/permission/request")).toHaveLength(1)
})
