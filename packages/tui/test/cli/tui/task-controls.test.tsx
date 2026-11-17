/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal } from "solid-js"
import {
  cardSession,
  cardTask,
  emergencyStopReady,
  pausedMessage,
  runningTasks,
  stopAllAvailable,
  taskApi,
  taskBackground,
  taskBadge,
  taskOptions,
  TaskControls,
  type TaskBackground,
  type TaskControlSnapshot,
} from "../../../src/component/task-controls"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const task = (input: Partial<TaskBackground> = {}): TaskBackground => ({
  sessionID: "child-1",
  agent: "explore",
  description: "Review fixtures",
  status: "running",
  ...input,
})
const snapshot = (input: Partial<TaskControlSnapshot> = {}): TaskControlSnapshot => ({
  paused: false,
  active: false,
  background: [],
  shells: [],
  ...input,
})

test("stop-all availability considers active response and running background tasks", () => {
  expect(stopAllAvailable("idle")).toBe(false)
  expect(stopAllAvailable("running")).toBe(true)
  expect(stopAllAvailable("idle", snapshot({ active: true }))).toBe(true)
  expect(stopAllAvailable("idle", snapshot({ background: [task()] }))).toBe(true)
  const shells = [{ id: "sh_running", sessionID: "child-1", command: "long job" }]
  expect(stopAllAvailable("idle", snapshot({ shells }))).toBe(true)
  expect(runningTasks(snapshot({ shells }))).toBe(1)
  expect(taskBadge(task({ status: "completed" }))).toBe("Completed")
  expect(stopAllAvailable("idle", snapshot({ background: [task({ status: "completed" })] }))).toBe(false)
  expect(runningTasks(snapshot({ background: [task(), task({ sessionID: "c2", status: "error" })] }))).toBe(1)
  expect(emergencyStopReady(1)).toBe(false)
  expect(emergencyStopReady(2)).toBe(true)
})

test("badges reflect observed task status only", () => {
  expect(taskBadge(undefined)).toBeUndefined()
  expect(taskBadge(task())).toBe("Background")
  expect(taskBadge(task({ status: "completed" }))).toBe("Completed")
  expect(taskBadge(task({ status: "error" }))).toBe("Failed")
  expect(taskBadge(task({ status: "cancelled" }))).toBe("Cancelled")
  expect(pausedMessage(1)).toContain("1 background task ")
  expect(pausedMessage(2)).toContain("2 background tasks ")
})

test("a continued subagent's background entry belongs only to the card it describes", () => {
  const latest = task({ description: "Convert aircraft-log extraction" })
  expect(cardTask(latest, "Convert aircraft-log extraction")).toBe(latest)
  expect(cardTask(latest, "Repair AN review defects")).toBeUndefined()
  expect(cardTask(undefined, "Repair AN review defects")).toBeUndefined()
})

test("a subagent card finds its session when the running call's metadata is missing", () => {
  expect(cardSession(undefined, "ses_reported", "ses_input", "Any")).toBe("ses_reported")
  expect(cardSession(undefined, undefined, "ses_continued", "Any")).toBe("ses_continued")
  const observed = snapshot({ background: [task({ sessionID: "ses_new", description: "Repair DV review blockers" })] })
  expect(cardSession(observed, undefined, undefined, "Repair DV review blockers")).toBe("ses_new")
  const ambiguous = snapshot({
    background: [task({ sessionID: "ses_a", description: "Same" }), task({ sessionID: "ses_b", description: "Same" })],
  })
  expect(cardSession(ambiguous, undefined, undefined, "Same")).toBeUndefined()
})

test("task snapshots resolve background tasks per child without inventing missing status", () => {
  const observed = snapshot({ background: [task(), task({ sessionID: "child-2", status: "cancelled" })] })
  expect(taskBackground(observed, "child-2")?.status).toBe("cancelled")
  expect(taskBackground(observed, "missing")).toBeUndefined()
  expect(taskBackground(undefined, "child-1")).toBeUndefined()
})

test("task options open the child session", () => {
  const opened: string[] = []
  const options = taskOptions([task(), task({ sessionID: "child-2", agent: "build", status: "completed" })], (id) =>
    opened.push(id),
  )
  expect(options.map((option) => option.title)).toEqual([
    "Running — explore: Review fixtures",
    "Completed — build: Review fixtures",
  ])
  options[1]!.onSelect()
  expect(opened).toEqual(["child-2"])
})

test("task api detection requires the generated task group", () => {
  expect(taskApi({ session: {} } as never)).toBeUndefined()
  const group = {
    status: async () => snapshot(),
    stopResponse: async () => ({}),
    resume: async () => ({}),
    stopAll: async () => ({}),
  }
  expect(taskApi({ session: { task: group } } as never)).toBe(group as never)
})

test("controls render the paused warning and switch between stop and resume", async () => {
  await using tmp = await tmpdir()
  const root = tmp.path
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const [current, setCurrent] = createSignal<TaskControlSnapshot | undefined>(
    snapshot({ paused: true, background: [task(), task({ sessionID: "child-2" })] }),
  )
  const calls: string[] = []
  const controls = {
    snapshot: current,
    stop: async () => void calls.push("stop"),
    resume: async () => void calls.push("resume"),
    all: async () => void calls.push("all"),
    tasks: () => void calls.push("tasks"),
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <TaskControls controls={controls} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 8 },
  )
  try {
    await app.waitForFrame((frame) => frame.includes("Resume controller"))
    const frame = app.captureCharFrame()
    expect(frame).toContain(pausedMessage(2))
    expect(frame).toContain("Stop all work")
    expect(frame).toContain("Background tasks (2 running)")
    expect(frame).not.toContain("Stop response only")
    setCurrent(snapshot({ active: true, background: [task({ status: "completed" })] }))
    await app.waitForFrame((frame) => frame.includes("Stop response only"))
    const next = app.captureCharFrame()
    expect(next).not.toContain("Resume controller")
    expect(next).not.toContain("Response stopped")
    expect(next).toContain("Background tasks (0 running)")
    setCurrent(undefined)
    await app.waitForFrame((frame) => !frame.includes("Stop all work"))
  } finally {
    app.renderer.destroy()
  }
})
