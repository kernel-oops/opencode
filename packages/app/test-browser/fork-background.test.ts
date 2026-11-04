import { expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionTaskStatus } from "@opencode/client"

// The shared task observer, as the client data store exposes it: counted views and reads that settle on demand.
const [tasks, setTasks] = createStore<Record<string, SessionTaskStatus | undefined>>({})
const [sessions, setSessions] = createStore<
  { id: string; parentID?: string; agent?: string; title?: string; metadata?: unknown }[]
>([])
const [active, setActive] = createStore<Record<string, "running" | "idle">>({})
const views: Record<string, number> = {}
const reads: Record<string, (() => void)[]> = {}
const data = {
  session: {
    list: () => sessions,
    get: (id: string) => sessions.find((session) => session.id === id),
    status: (id: string) => active[id] ?? "idle",
    task: {
      get: (id: string) => tasks[id],
      observe(id: string) {
        views[id] = (views[id] ?? 0) + 1
        let released = false
        return () => {
          if (released) return
          released = true
          views[id]--
        }
      },
      sync: (id: string) => new Promise<void>((resolve) => (reads[id] ??= []).push(resolve)),
    },
  },
}
const settle = async (id: string) => {
  reads[id]?.splice(0).forEach((resolve) => resolve())
  await new Promise((resolve) => setTimeout(resolve, 0))
}

mock.module("@/runtime/server/current", () => ({ useData: () => data, useServer: () => ({ key: "local" }) }))
mock.module("@/runtime/server/client", () => ({ useServerSDK: () => ({ api: {} }) }))

const { createSessionBackground } = await import("../src/features/background/tab")

test("session background reads the shared task observer honestly across failures and session switches", async () => {
  const [sessionID, setSessionID] = createSignal("root")
  const { background, dispose } = createRoot((dispose) => ({ background: createSessionBackground(sessionID), dispose }))
  const listed = () => background.subagents().map((item) => `${item.sessionID}:${item.status}`)

  try {
    expect(views).toEqual({ root: 1 })
    expect(background.phase()).toBe("loading")

    // The first read fails: unavailable, not empty, and running children are still listed.
    setSessions([{ id: "live", parentID: "root", agent: "explore", title: "Look around" }])
    setActive("live", "running")
    await settle("root")
    expect(background.phase()).toBe("unavailable")
    expect(listed()).toEqual(["live:running"])
    expect(background.running()).toBe(1)

    // The observer recovers: every tracked status stays listed, running work first.
    setActive("live", "idle")
    setTasks("root", {
      paused: true,
      active: true,
      background: [
        { sessionID: "done", agent: "build", description: "Finish", status: "completed" },
        { sessionID: "failed", agent: "build", description: "Break", status: "error" },
        { sessionID: "busy", agent: "Cat", description: "Work", status: "running" },
        { sessionID: "gone", agent: "build", description: "Stop", status: "cancelled" },
      ],
    })
    expect(background.phase()).toBe("ready")
    expect(listed()).toEqual(["busy:running", "done:completed", "failed:error", "gone:cancelled", "live:idle"])
    expect(background.controls.paused()).toBe(true)

    // A tracked job and its saved relation are one row, and live status wins over an older terminal job.
    setSessions([{ id: "done", parentID: "root", agent: "build", title: "Finish" }])
    setActive("done", "running")
    expect(listed()).toEqual(["done:running", "busy:running", "failed:error", "gone:cancelled"])
    expect(background.running()).toBe(2)

    // A running grandchild belongs below its idle owner, even if its tracked job arrived first.
    setSessions([
      { id: "grand", parentID: "owner", agent: "Lister", title: "Nested work" },
      { id: "owner", parentID: "root", agent: "Cat", title: "Idle owner" },
      { id: "unrelated", parentID: "elsewhere", title: "Unrelated work" },
    ])
    setTasks("root", {
      paused: false,
      active: false,
      background: [{ sessionID: "grand", agent: "Lister", description: "Tracked nested work", status: "running" }],
    })
    expect(background.subagents().map((item) => [item.sessionID, item.depth, item.status])).toEqual([
      ["owner", 0, "idle"],
      ["grand", 1, "running"],
    ])
    expect(background.subagents()[1]?.description).toBe("Tracked nested work")
    expect(background.running()).toBe(1)

    // A later failure reads as unavailable again rather than as nothing running.
    setTasks("root", undefined)
    expect(background.phase()).toBe("unavailable")

    // Another session: the old observation is released, and a late read for a left session changes nothing.
    setSessionID("other")
    expect(views).toEqual({ root: 0, other: 1 })
    expect(background.phase()).toBe("loading")
    setSessionID("root")
    setSessionID("other")
    await settle("root")
    expect(background.phase()).toBe("loading")
    setTasks("other", { paused: false, active: false, background: [] })
    await settle("other")
    expect(background.phase()).toBe("ready")
    expect(listed()).toEqual([])
  } finally {
    dispose()
  }
  expect(views).toEqual({ root: 0, other: 0 })
})
