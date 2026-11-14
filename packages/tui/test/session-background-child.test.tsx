import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const session = (id: string, parentID?: string) => ({
  id,
  title: id === "root" ? "Controller" : "Worker",
  parentID,
  agent: "build",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
})
const sessions = [session("root"), session("child", "root")]
const messages = [
  { type: "user", id: "user-1", text: "Run it", time: { created: 0 } },
  {
    type: "assistant",
    id: "assistant-1",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "call-1",
        name: "shell",
        time: { created: 1, ran: 1 },
        state: { status: "running", input: { command: "sleep 600" }, metadata: {} },
      },
    ],
  },
]

async function render(status: number) {
  const backgrounded: string[] = []
  const app = await createAppFixture({
    width: 100,
    height: 30,
    args: { sessionID: "child" },
    config: { animations: false, session: { sidebar: "hide" }, tabs: { enabled: false } },
    fetch: (url, request) => {
      if (url.pathname === "/api/session/active") return json({ data: { child: { type: "running" } } })
      if (url.pathname === "/api/session") {
        const parent = url.searchParams.get("parentID")
        return json({ data: parent ? sessions.filter((item) => item.parentID === parent) : sessions, cursor: {} })
      }
      const background = url.pathname.match(/^\/api\/session\/([^/]+)\/background$/)?.[1]
      if (background && request.method === "POST") {
        backgrounded.push(background)
        return status === 204 ? new Response(null, { status }) : json({ message: "nope" }, { status })
      }
      if (url.pathname === "/api/session/child/message") return json({ data: messages.toReversed(), cursor: {} })
      const id = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1]
      if (id) return json({ data: sessions.find((item) => item.id === id) })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
    },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("to move running work to the background"))
  return { app, backgrounded }
}

test("ctrl+b in a child session backgrounds the child's running shell", async () => {
  const { app, backgrounded } = await render(204)
  await using _ = app
  app.mockInput.pressKey("b", { ctrl: true })
  await Bun.sleep(100)
  expect(backgrounded).toEqual(["child"])
})

test("a failed background request shows a toast", async () => {
  const { app, backgrounded } = await render(404)
  await using _ = app
  app.mockInput.pressKey("b", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("Failed to move work to the background"))
  expect(backgrounded).toEqual(["child"])
})
