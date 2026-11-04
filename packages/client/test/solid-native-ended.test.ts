import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent } from "../src/promise"

const wait = async (predicate: () => boolean) => {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out waiting for the reducer")
}

const assistant = (id: string, native?: Record<string, unknown>) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  time: { created: 1 },
  content: [],
  ...(native ? { native } : {}),
})

test("public steer native-ended projects each response separately and keeps absent usage unknown", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async () =>
      Response.json({
        data: [assistant("msg_parent", { completedOutputItems: [{ type: "message", id: "item_done" }] }), assistant("msg_successor")],
        cursor: {},
      }),
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const emit = (event: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: event.type, details: event }))
  try {
    await setup.data.session.message.sync("ses_steer")
    emit({
      id: "evt_parent",
      created: 3,
      type: "session.step.native-ended",
      durable: { aggregateID: "ses_steer", seq: 1, version: 1 },
      data: {
        sessionID: "ses_steer",
        assistantMessageID: "msg_parent",
        protocol: "response.steer",
        boundary: "steered",
        finish: "stop",
        rawFinish: "steered",
        native: { responseId: "resp_parent", nativeSteered: true },
      },
    })
    emit({
      id: "evt_successor",
      created: 4,
      type: "session.step.native-ended",
      durable: { aggregateID: "ses_steer", seq: 2, version: 1 },
      data: {
        sessionID: "ses_steer",
        assistantMessageID: "msg_successor",
        protocol: "response.steer",
        boundary: "completed",
        finish: "stop",
        native: { responseId: "resp_successor" },
        usage: { cost: 0.25, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
      },
    })
    await wait(() => setup.data.session.message.get("ses_steer", "msg_successor")?.time.completed === 4)
    const parent = setup.data.session.message.get("ses_steer", "msg_parent")
    const successor = setup.data.session.message.get("ses_steer", "msg_successor")
    expect(parent).toMatchObject({
      time: { completed: 3 },
      finish: "stop",
      rawFinish: "steered",
      native: { responseId: "resp_parent", nativeSteered: true, completedOutputItems: [{ type: "message", id: "item_done" }] },
    })
    // Unknown parent usage is not manufactured as zero, and the successor's usage is its own.
    expect(parent?.type === "assistant" ? parent.cost : "wrong").toBeUndefined()
    expect(parent?.type === "assistant" ? parent.tokens : "wrong").toBeUndefined()
    expect(successor).toMatchObject({ cost: 0.25, tokens: { input: 10, output: 5 }, native: { responseId: "resp_successor" } })
  } finally {
    setup.dispose()
  }
})
