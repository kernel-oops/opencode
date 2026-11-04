/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarTasks } from "../src/tui"
import type { SessionTaskStatus } from "@opencode/client"

const [statuses, publishTaskStatus] = createStore<Record<string, SessionTaskStatus | undefined>>({})

type Session = { id: string; parentID?: string; title: string; agent?: string; metadata?: unknown }

function context(sessions: Session[], running: string[], shells: () => unknown[] = () => []) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { warning: { base: color }, error: { base: color }, success: { base: color } },
      },
    },
    data: {
      on: () => () => {},
      shell: { list: shells, sync: async () => {}, invalidate: () => {} },
      session: {
        task: { get: (id: string) => statuses[id], observe: () => () => {} },
        descendants: { sync: async () => {}, invalidate: () => {} },
        list: () => sessions.map((session) => ({ ...session, location: { directory: "/fixture" } })),
        status: (id: string) => (running.includes(id) ? "running" : "idle"),
      },
    },
    ui: { router: { navigate: () => {} } },
  } as unknown as Context
}

const snapshot = (background: Array<{ sessionID: string; agent: string; description: string; status: string }>) =>
  ({ paused: false, active: false, background }) as never

async function frameOf(ctx: Context, sessionID = "parent") {
  const app = await testRender(() => <SidebarTasks context={ctx} sessionID={sessionID} />, { width: 60, height: 10 })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

afterEach(() => publishTaskStatus("parent", undefined))

test("nothing is shown when the session has no tracked jobs and no running descendants", async () => {
  const frame = await frameOf(context([{ id: "parent", title: "Parent" }], []))
  expect(frame).not.toContain("Subagents")
})

test("a running child that no job tracks is listed with a running count", async () => {
  const sessions = [
    { id: "parent", title: "Controller" },
    { id: "child", parentID: "parent", title: "Implement integrated v32 convergence", agent: "lister" },
    { id: "sibling", parentID: "parent", title: "Sibling", agent: "cat" },
  ]
  const frame = await frameOf(context(sessions, ["child", "sibling"]))
  expect(frame).toContain("Subagents (2 running)")
  expect(frame).toContain("Lister Implement integrated v32 convergence")
})

test("an idle untracked child is not listed", async () => {
  const sessions = [
    { id: "parent", title: "P" },
    { id: "child", parentID: "parent", title: "Finished work", agent: "cat" },
  ]
  expect(await frameOf(context(sessions, []))).not.toContain("Finished work")
})

test("running grandchildren retain idle parent context without inflating the running count", async () => {
  publishTaskStatus(
    "parent",
    snapshot([{ sessionID: "grand", agent: "Lister", description: "Nested work", status: "running" }]),
  )
  const sessions = [
    { id: "parent", title: "Controller" },
    { id: "grand", parentID: "child", title: "Nested work", agent: "lister" },
    { id: "grand-sibling", parentID: "child", title: "Nested sibling", agent: "cat" },
    { id: "child", parentID: "parent", title: "Idle owner", agent: "cat" },
    { id: "other", parentID: "parent", title: "Unrelated idle", agent: "cat" },
  ]
  const frame = await frameOf(context(sessions, ["grand", "grand-sibling"]))
  expect(frame).toContain("Subagents (2 running)")
  expect(frame).toContain("Idle owner")
  expect(frame).toMatch(/├ \S Lister Nested work/)
  expect(frame).toMatch(/└ \S Cat Nested sibling/)
  expect(frame).not.toContain("└─")
  expect(frame.indexOf("Idle owner")).toBeLessThan(frame.indexOf("Nested work"))
  expect(frame).not.toContain("Unrelated idle")
})

test("tracked jobs still show, are not duplicated, and a completed job whose session runs again shows as running", async () => {
  publishTaskStatus(
    "parent",
    snapshot([
      { sessionID: "woken", agent: "Lister", description: "Build family owner", status: "completed" },
      { sessionID: "done", agent: "Cat", description: "Verify suite", status: "completed" },
    ]),
  )
  const sessions = [
    { id: "parent", title: "P" },
    { id: "woken", parentID: "parent", title: "Build family owner", agent: "lister" },
    { id: "done", parentID: "parent", title: "Verify suite", agent: "cat" },
  ]
  const frame = await frameOf(context(sessions, ["woken"]))
  expect(frame).toContain("Subagents (1 running)")
  expect(frame.match(/Build family owner/g)).toHaveLength(1)
  expect(frame).toContain("Verify suite")
})

const shell = (id: string, owner?: string, background?: boolean) => ({
  id,
  command: `command-${id}`,
  status: "running",
  metadata: { sessionID: owner, background },
  time: { started: Date.now() },
})
test("idle transitive native owners are shown, deduplicated and isolated from unrelated owners", async () => {
  const sessions = [
    { id: "parent", title: "Controller" },
    { id: "child", parentID: "parent", title: "Finished child", agent: "cat" },
    { id: "grand", parentID: "child", title: "Grandchild", agent: "lister" },
    { id: "other", title: "Other" },
  ]
  const inventory = [
    shell("child", "child"),
    shell("grand", "grand", true),
    shell("other", "other"),
    shell("none"),
    shell("missing", "missing"),
  ]
  const frame = await frameOf(context(sessions, [], () => [...inventory, inventory[0]!]))
  expect(frame).toContain("Shell commands (2 running)")
  expect(frame).not.toContain("Shell running")
  expect(frame).not.toContain("Background running")
  expect(frame).toContain("Owner: Cat · Finished child")
  expect(frame).not.toContain("Subagents")
  expect(frame).not.toContain("command-other")
  expect(frame).not.toContain("command-none")
  expect(frame.match(/command-child/g)).toHaveLength(1)
  const childFrame = await frameOf(
    context(sessions, [], () => [shell("parent", "parent"), shell("other", "other"), shell("grand", "grand")]),
    "child",
  )
  expect(childFrame).toContain("command-grand")
  expect(childFrame).not.toContain("command-parent")
  expect(childFrame).not.toContain("command-other")
})
test("reactive shell removal preserves neutral narrow-layout status and makes no success claim", async () => {
  const [inventory, setInventory] = createSignal([shell("live", "parent")])
  const app = await testRender(
    () => <SidebarTasks context={context([{ id: "parent", title: "P" }], [], inventory)} sessionID="parent" />,
    { width: 30, height: 12 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Shell running")
    expect(app.captureCharFrame()).toContain("Owner: Session · P")
    setInventory([])
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Shell commands")
    expect(app.captureCharFrame()).not.toContain("completed")
  } finally {
    app.renderer.destroy()
  }
})

test.each([30, 38, 42, 100])("multiline heredoc shell summary stays one line at width %i", async (width) => {
  const command = `\n\t SIDEBAR_NATIVE_COLD_COMMAND\t <<'PY'\r\n${"DO_NOT_DISPLAY_SCRIPT\n".repeat(100)}PY`
  const app = await testRender(
    () => (
      <SidebarTasks
        context={context([{ id: "parent", title: "P" }], [], () => [
          { ...shell("script", "parent"), command, time: { started: Date.now() - 120_000 } },
        ])}
        sessionID="parent"
      />
    ),
    { width, height: 12 },
  )
  try {
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    expect(lines.filter((line) => line.includes("SIDEBAR"))).toHaveLength(1)
    expect(lines.find((line) => line.includes("SIDEBAR"))).toContain("2m")
    expect(app.captureCharFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    expect(lines.some((line) => line.includes("2m"))).toBe(true)
    expect(lines.some((line) => line.includes("Owner: Session · P"))).toBe(true)
    expect(app.captureCharFrame()).not.toContain("DO_NOT_DISPLAY_SCRIPT")
    // Header, summary and owner, not a script-height row.
    expect(lines.filter((line) => line.trim())).toHaveLength(3)
  } finally {
    app.renderer.destroy()
  }
})

test("shell owner action navigates independently on mouse release and reconnect refreshes inventory", async () => {
  const ctx = context(
    [
      { id: "parent", title: "P" },
      { id: "child", parentID: "parent", title: "Child", agent: "cat" },
    ],
    [],
    () => [shell("owned", "child")],
  )
  const routes: unknown[] = []
  const refreshes: string[] = []
  let connected = () => {}
  const input = {
    ...ctx,
    data: {
      ...ctx.data,
      on: (_type: string, handler: () => void) => {
        connected = handler
        return () => {}
      },
      shell: {
        ...ctx.data.shell,
        sync: async () => {
          refreshes.push("sync")
        },
        invalidate: () => {
          refreshes.push("invalidate")
        },
      },
    },
    ui: {
      ...ctx.ui,
      router: {
        ...ctx.ui.router,
        navigate: (route: unknown) => {
          routes.push(route)
        },
      },
    },
  } as unknown as Context
  const app = await testRender(() => <SidebarTasks context={input} sessionID="parent" />, { width: 60, height: 10 })
  try {
    await app.renderOnce()
    expect(refreshes).toEqual(["sync"])
    connected()
    expect(refreshes).toEqual(["sync", "invalidate", "sync"])
    const action = app.renderer.root.findDescendantById("sidebar.shell.owner.owned")!
    await app.mockMouse.click(action.x, action.y)
    expect(routes).toEqual([{ type: "session", sessionID: "child" }])
  } finally {
    app.renderer.destroy()
  }
})

test("native commands coexist with truthful completed subagents", async () => {
  publishTaskStatus(
    "parent",
    snapshot([{ sessionID: "child", agent: "Cat", description: "Finished agent", status: "completed" }]),
  )
  const frame = await frameOf(
    context(
      [
        { id: "parent", title: "P" },
        { id: "child", parentID: "parent", title: "Finished agent", agent: "cat" },
      ],
      [],
      () => [shell("native", "child")],
    ),
  )
  expect(frame).toContain("Shell commands (1 running)")
  expect(frame).toContain("Subagents")
  expect(frame).not.toContain("Subagents (1 running)")
  expect(frame).toContain("Finished agent")
})

for (const separate of [false, true])
  for (const selected of ["parent", "child"]) {
    test(`cold production data hydrates ${selected} idle descendants (${separate ? "different" : "same"} location)`, async () => {
      const { createData } = await import("@opencode/client/solid")
      const { OpenCode } = await import("@opencode/client/promise")
      const location = { directory: "/fixture/a" }
      const info = (id: string, parentID?: string) => ({
        id,
        parentID,
        projectID: "fixture",
        title: id,
        agent: "cat",
        cost: 0,
        outcome: "succeeded",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1, idle: 2 },
        location: id === "grand" && separate ? { directory: "/fixture/b" } : location,
      })
      const requests: string[] = []
      const api = OpenCode.make({
        baseUrl: "http://fixture.invalid",
        fetch: Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL((input instanceof Request ? input : new Request(input, init)).url)
            requests.push(url.pathname + url.search)
            if (url.pathname === "/api/session/parent") return Response.json({ data: info("parent") })
            if (url.pathname === "/api/session/child") return Response.json({ data: info("child", "parent") })
            if (url.pathname === "/api/session") {
              const parent = url.searchParams.get("parentID")
              if (parent === "parent" && !url.searchParams.get("cursor"))
                return Response.json({ data: [info("empty", "parent")], cursor: { next: "page2" } })
              if (parent === "parent") return Response.json({ data: [info("child", "parent")], cursor: {} })
              if (parent === "child") return Response.json({ data: [info("grand", "child")], cursor: {} })
              return Response.json({ data: [], cursor: {} })
            }
            if (url.pathname === "/api/shell")
              return Response.json({
                location: { directory: url.searchParams.get("location[directory]") },
                data: [{ ...shell("cold", "grand"), cwd: "/fixture", shell: "/bin/sh", file: "/fixture/output" }],
              })
            throw new Error(`Unexpected fixture request ${url}`)
          },
          { preconnect: () => {} },
        ),
      })
      const base = context([], [])
      const app = await testRender(
        () => {
          const data = createData({
            api: () => api,
            directory: location.directory,
            event: { on: () => () => {}, listen: () => () => {} },
          })
          return <SidebarTasks context={{ ...base, data } as unknown as Context} sessionID={selected} />
        },
        { width: 60, height: 15 },
      )
      try {
        // Drain the finite local HTTP/memo chain, not a timer or production poll.
        for (let i = 0; i < 20; i++) await app.renderOnce()
        expect(app.captureCharFrame()).toContain("command-cold")
        expect(app.captureCharFrame()).toContain("Owner: Cat · grand")
        expect(app.captureCharFrame()).not.toContain("Subagents")
        expect(requests.some((request) => request.includes("cursor=page2"))).toBe(selected === "parent")
        expect(requests.some((request) => request.includes("parentID=grand"))).toBe(true)
        expect(requests.filter((request) => request.includes("parentID=parent"))).toHaveLength(
          selected === "parent" ? 2 : 0,
        )
        if (selected === "child") expect(requests.some((request) => request.includes("/session/parent"))).toBe(false)
        if (separate) expect(requests.some((request) => request.includes("%2Ffixture%2Fb"))).toBe(true)
      } finally {
        app.renderer.destroy()
      }
    })
  }
