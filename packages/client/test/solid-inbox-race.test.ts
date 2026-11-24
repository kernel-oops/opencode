import { afterEach, expect, jest, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInboxItem } from "../src/promise"

const item: SessionInboxItem = {
  id: "msg_remote",
  sessionID: "ses_remote",
  type: "user",
  delivery: "steer",
  time: { created: 1 },
  payload: { text: "Check the remote preview" },
}

function fixture(fetch: (request: Request) => Promise<Response>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: (input, init) => fetch(input instanceof Request ? input : new Request(input, init)),
  })
  return createRoot((dispose) => ({
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
    }),
    emit: (event: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: event.type, details: event })),
    dispose,
  }))
}

const enqueued: OpenCodeEvent = {
  id: "evt_enqueued",
  type: "session.inbox.enqueued",
  created: 1,
  durable: { aggregateID: item.sessionID, seq: 1, version: 1 },
  data: {
    sessionID: item.sessionID,
    inboxID: item.id,
    item: { type: item.type, delivery: item.delivery, payload: item.payload },
  },
}

test.each(["session.execution.failed", "session.execution.succeeded"] as const)(
  "reconciles a missed delivery at %s without dropping other pending inputs",
  async (type) => {
    const digest: SessionInboxItem = {
      id: "msg_digest", sessionID: item.sessionID, type: "synthetic", delivery: "steer",
      time: { created: 1 }, payload: { text: "digest" },
    }
    const queued: SessionInboxItem = { ...item, id: "msg_queued", delivery: "queue" }
    const gate = Promise.withResolvers<void>()
    let pending: SessionInboxItem[] = [digest, item, queued]
    const setup = fixture(async (request) => {
      if (request.method === "GET") return Response.json({ data: pending })
      return Response.json({ data: { id: "msg_local" } })
    })
    try {
      await setup.data.session.pending.sync(item.sessionID)
      const admission = setup.data.session.prompt({ sessionID: item.sessionID, id: "msg_local", text: "local", gate: gate.promise })
      // The server consumed the digest, but this client missed the delivery event.
      pending = [item, queued]
      setup.emit({
        id: "evt_terminal", created: 3, type,
        durable: { aggregateID: item.sessionID, seq: 3, version: 1 },
        data: { sessionID: item.sessionID, ...(type === "session.execution.failed" ? { error: { type: "provider.no-route", message: "failure" } } : {}) },
      })
      await setup.data.session.pending.sync(item.sessionID)
      expect(setup.data.session.pending.list(item.sessionID).map((entry) => entry.id)).toEqual([item.id, queued.id, "msg_local"])
      expect(setup.data.session.message.get(item.sessionID, digest.id)?.text).toBe("digest")
      gate.resolve()
      await admission
    } finally {
      gate.resolve()
      setup.dispose()
    }
  },
)

test("revalidates an older in-flight inbox snapshot at an execution boundary", async () => {
  const response = Promise.withResolvers<Response>()
  let reads = 0
  const setup = fixture(async () => ++reads === 1 ? response.promise : Response.json({ data: [] }))
  try {
    const older = setup.data.session.pending.sync(item.sessionID)
    setup.emit({
      id: "evt_terminal", created: 3, type: "session.execution.succeeded",
      durable: { aggregateID: item.sessionID, seq: 3, version: 1 }, data: { sessionID: item.sessionID },
    })
    response.resolve(Response.json({ data: [item] }))
    await older
    await setup.data.session.pending.sync(item.sessionID)
    expect(reads).toBe(2)
    expect(setup.data.session.pending.list(item.sessionID)).toEqual([])
  } finally {
    response.resolve(Response.json({ data: [] }))
    setup.dispose()
  }
})

test("a successful admission reconciles a consumed optimistic input from one fresh transcript read", async () => {
  const response = Promise.withResolvers<Response>()
  const reading = Promise.withResolvers<void>()
  let reads = 0
  const setup = fixture(async (request) => {
    if (request.method === "POST") return response.promise
    if (!new URL(request.url).pathname.endsWith("/message")) return Response.json({ data: [item] })
    reads++
    reading.resolve()
    // The server delivered the prompt while this client missed both inbox events.
    return Response.json({ data: [{ id: "msg_local", type: "user", text: "local", time: { created: 2 } }], cursor: {} })
  })
  try {
    const admission = setup.data.session.prompt({ sessionID: item.sessionID, id: "msg_local", text: "local" })
    await setup.data.session.pending.sync(item.sessionID)
    expect(setup.data.session.input.list(item.sessionID)).toContain("msg_local")
    response.resolve(Response.json({ data: { ...item, id: "msg_local", payload: { text: "local" } } }))
    await admission
    await reading.promise
    await setup.data.session.message.sync(item.sessionID)
    expect(reads).toBe(1)
    expect(setup.data.session.input.list(item.sessionID)).toEqual([item.id])
    expect(setup.data.session.message.get(item.sessionID, "msg_local")?.time.created).toBe(2)
    // Another inbox read cannot resurrect the delivered prompt.
    setup.data.session.pending.invalidate(item.sessionID)
    await setup.data.session.pending.sync(item.sessionID)
    expect(setup.data.session.input.list(item.sessionID)).toEqual([item.id])
    expect(reads).toBe(1)
  } finally {
    response.resolve(Response.json({ data: item }))
    setup.dispose()
  }
})

test("an older transcript read cannot erase an accepted prompt before its delivery proof", async () => {
  const transcripts = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
  let reads = 0
  const setup = fixture(async (request) => {
    if (request.method === "POST") return Response.json({ data: { id: item.id } })
    if (new URL(request.url).pathname.endsWith("/message")) return transcripts[reads++]!.promise
    return Response.json({ data: [] })
  })
  try {
    const older = setup.data.session.message.sync(item.sessionID)
    await setup.data.session.prompt({ sessionID: item.sessionID, id: item.id, text: item.payload.text })
    await setup.data.session.pending.sync(item.sessionID)
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(true)
    // The held read predates admission.
    transcripts[0]!.resolve(Response.json({ data: [], cursor: {} }))
    await older
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(true)
    expect(setup.data.session.message.get(item.sessionID, item.id)?.type).toBe("user")
    transcripts[1]!.resolve(Response.json(transcript))
    await setup.data.session.message.sync(item.sessionID)
    expect(reads).toBe(2)
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(false)
    expect(setup.data.session.message.get(item.sessionID, item.id)?.time.created).toBe(2)
  } finally {
    transcripts.forEach((entry) => entry.resolve(Response.json({ data: [], cursor: {} })))
    setup.dispose()
  }
})

test("an accepted prompt stays queued without holding back the next admission", async () => {
  const inbox = Promise.withResolvers<Response>()
  const posts: string[] = []
  let reads = 0
  const setup = fixture(async (request) => {
    if (request.method === "POST") {
      const body = (await request.json()) as { id: string }
      posts.push(body.id)
      return Response.json({ data: { id: body.id } })
    }

    if (new URL(request.url).pathname.endsWith("/message")) reads++
    return inbox.promise.then((value) => value.clone())
  })
  const queued: SessionInboxItem = { ...item, id: "msg_first", delivery: "queue", payload: { text: "First" } }
  const second: SessionInboxItem = { ...item, id: "msg_second", payload: { text: "Second" } }
  try {
    await setup.data.session.prompt({ sessionID: item.sessionID, id: queued.id, text: "First", delivery: "queue" })
    await setup.data.session.prompt({ sessionID: item.sessionID, id: second.id, text: "Second" })
    expect(posts).toEqual([queued.id, second.id])
    expect(setup.data.session.input.list(item.sessionID)).toEqual([queued.id, second.id])
    expect(setup.data.session.pending.status(item.sessionID, queued.id)).toBe("queued")
    // A positive inbox read, not a transcript read, settles both as server state.
    inbox.resolve(Response.json({ data: [queued, second] }))
    await setup.data.session.pending.sync(item.sessionID)
    expect(setup.data.session.input.list(item.sessionID)).toEqual([queued.id, second.id])
    expect(reads).toBe(0)
  } finally {
    inbox.resolve(Response.json({ data: [] }))
    setup.dispose()
  }
})

test("a rejected admission rolls back only its own row, and a failed retry keeps the accepted one", async () => {
  const inbox = Promise.withResolvers<Response>()
  let posts = 0
  const setup = fixture(async (request) => {
    if (request.method === "POST")
      return ++posts === 1 ? Response.json({ data: { id: "msg_first" } }) : new Response("Admission failed", { status: 500 })
    return inbox.promise.then((value) => value.clone())
  })
  try {
    await setup.data.session.prompt({ sessionID: item.sessionID, id: "msg_first", text: "First" })
    await expect(setup.data.session.prompt({ sessionID: item.sessionID, id: "msg_second", text: "Second" })).rejects.toThrow()
    await expect(setup.data.session.prompt({ sessionID: item.sessionID, id: "msg_first", text: "First" })).rejects.toThrow()
    expect(setup.data.session.input.list(item.sessionID)).toEqual(["msg_first"])
    expect(setup.data.session.message.get(item.sessionID, "msg_first")?.type).toBe("user")
    expect(setup.data.session.message.get(item.sessionID, "msg_second")).toBeUndefined()
  } finally {
    inbox.resolve(Response.json({ data: [] }))
    setup.dispose()
  }
})

test.each([
  ["delivered", "succeeds"],
  ["cancelled", "succeeds"],
  ["delivered", "fails"],
] as const)("a prompt %s before its POST %s is not resurrected or rolled back", async (action, outcome) => {
  const response = Promise.withResolvers<Response>()
  let reads = 0
  const setup = fixture(async (request) => {
    if (request.method === "POST") return response.promise
    reads++
    return Response.json({ data: [], cursor: {} })
  })
  try {
    const admission = setup.data.session
      .prompt({ sessionID: item.sessionID, id: item.id, text: item.payload.text })
      .catch(() => undefined)
    setup.emit({
      id: "evt_consumed",
      type: `session.inbox.${action}`,
      created: 2,
      durable: { aggregateID: item.sessionID, seq: 2, version: 1 },
      data: { sessionID: item.sessionID, inboxID: item.id },
    })
    response.resolve(
      outcome === "succeeds" ? Response.json({ data: { id: item.id } }) : new Response("Lost response", { status: 500 }),
    )
    await admission
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(false)
    const message = setup.data.session.message.get(item.sessionID, item.id)
    if (action === "cancelled") expect(message).toBeUndefined()
    else expect(message?.time.created).toBe(2)
    expect(reads).toBe(0)
  } finally {
    response.resolve(Response.json({ data: item }))
    setup.dispose()
  }
})

test.each(["delivered", "cancelled"] as const)(
  "a delayed inbox snapshot cannot resurrect a %s prompt",
  async (action) => {
    const response = Promise.withResolvers<Response>()
    const setup = fixture(() => response.promise)
    try {
      setup.emit(enqueued)
      const reading = setup.data.session.pending.sync(item.sessionID)
      setup.emit({
        id: "evt_consumed",
        type: `session.inbox.${action}`,
        created: 2,
        durable: { aggregateID: item.sessionID, seq: 2, version: 1 },
        data: { sessionID: item.sessionID, inboxID: item.id },
      })
      expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(false)
      response.resolve(Response.json({ data: [item] }))
      await reading
      expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(false)
      const message = setup.data.session.message.get(item.sessionID, item.id)
      if (action === "cancelled") expect(message).toBeUndefined()
      else expect(message?.time.created).toBe(2)
    } finally {
      response.resolve(Response.json({ data: [] }))
      setup.dispose()
    }
  },
)

test.each(["enqueue", "delivery"] as const)("inbox hydration retains a concurrent %s event", async (action) => {
  const response = Promise.withResolvers<Response>()
  const setup = fixture(() => response.promise)
  try {
    const reading = setup.data.session.pending.sync(item.sessionID)
    setup.emit(
      action === "enqueue"
        ? enqueued
        : {
            id: "evt_delivery",
            type: "session.inbox.delivery.changed",
            created: 2,
            durable: { aggregateID: item.sessionID, seq: 2, version: 1 },
            data: { sessionID: item.sessionID, inboxID: item.id, delivery: "steer" },
          },
    )
    response.resolve(Response.json({ data: action === "enqueue" ? [] : [{ ...item, delivery: "queue" }] }))
    await reading
    expect(setup.data.session.pending.list(item.sessionID)).toEqual([item])
  } finally {
    response.resolve(Response.json({ data: [] }))
    setup.dispose()
  }
})

test("hydration preserves submission order across optimistic admissions", async () => {
  const response = Promise.withResolvers<Response>()
  const gate = Promise.withResolvers<void>()
  const setup = fixture((request) =>
    request.method === "GET" ? response.promise.then((value) => value.clone()) : Promise.resolve(Response.json({ data: { id: "msg_admitted" } })),
  )
  try {
    const first = setup.data.session.prompt({
      sessionID: item.sessionID,
      id: "msg_first",
      text: "First",
      gate: gate.promise,
    })
    const reading = setup.data.session.pending.sync(item.sessionID)
    const second = setup.data.session.prompt({
      sessionID: item.sessionID,
      id: "msg_second",
      text: "Second",
      gate: gate.promise,
    })
    response.resolve(Response.json({ data: [] }))
    await reading
    expect(setup.data.session.input.list(item.sessionID)).toEqual(["msg_first", "msg_second"])
    gate.resolve()
    await Promise.all([first, second])
  } finally {
    response.resolve(Response.json({ data: [] }))
    gate.resolve()
    setup.dispose()
  }
})

test("a sequenced request leaves only once the prompt made before it has settled, and a failed one does not block the next", async () => {
  const prepared = Promise.withResolvers<void>()
  const paths: string[] = []
  const setup = fixture((request) => {
    paths.push(new URL(request.url).pathname.split("/").at(-1) ?? "")
    return Promise.resolve(Response.json({ data: { id: "msg_admitted" } }))
  })
  try {
    // The prompt still prepares, as it does while a plugin readies the session for it.
    const first = setup.data.session.prompt({ sessionID: item.sessionID, id: "msg_first", text: "First", prepare: () => prepared.promise })
    const failing = setup.data.session.sequence(item.sessionID, () => Promise.reject(new Error("command failed")))
    const last = setup.data.session.sequence(item.sessionID, async () => void paths.push("shell"))
    const failed = failing.catch((error: Error) => error.message)
    await Bun.sleep(0)
    expect(paths).toEqual([])

    prepared.resolve()
    await Promise.all([first, failed, last])
    expect(paths).toEqual(["prompt", "shell"])
    expect(await failed).toBe("command failed")
  } finally {
    prepared.resolve()
    setup.dispose()
  }
})

afterEach(() => void jest.useRealTimers())

test("a sequenced request that stays open holds the next send until it has reached the server, not until it ends", async () => {
  jest.useFakeTimers()
  const prepared = Promise.withResolvers<void>()
  const paths: string[] = []
  const setup = fixture((request) => {
    paths.push(new URL(request.url).pathname.split("/").at(-1) ?? "")
    return Promise.resolve(Response.json({ data: { id: "msg_admitted" } }))
  })
  // A shell command's request: the server answers it when the command's process exits.
  const exited = Promise.withResolvers<void>()
  const flush = async () => {
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
  }
  try {
    const shell = setup.data.session.sequence(
      item.sessionID,
      () => (paths.push("shell"), exited.promise),
      () => prepared.promise,
    )
    const prompt = setup.data.session.prompt({ sessionID: item.sessionID, id: "msg_after", text: "After" })
    // What the shell command waits for before it leaves does not let the prompt overtake it, however long it takes.
    jest.advanceTimersByTime(60_000)
    await flush()
    expect(paths).toEqual([])

    prepared.resolve()
    await flush()
    expect(paths).toEqual(["shell"])
    // The command still runs. The prompt leaves once the command's request has had its moment to arrive.
    jest.advanceTimersToNextTimer()
    await prompt
    expect(paths).toEqual(["shell", "prompt"])

    exited.resolve()
    await shell
  } finally {
    prepared.resolve()
    exited.resolve()
    setup.dispose()
  }
})

test("hydration coalesces a concurrent optimistic compaction even if its POST fails", async () => {
  const response = Promise.withResolvers<Response>()
  const admission = Promise.withResolvers<Response>()
  const setup = fixture((request) => (request.method === "GET" ? response.promise : admission.promise))
  const canonical: SessionInboxItem = {
    id: "msg_canonical",
    sessionID: item.sessionID,
    type: "compaction",
    delivery: "steer",
    time: { created: 1 },
    payload: {},
  }
  try {
    const reading = setup.data.session.pending.sync(item.sessionID)
    const compacting = setup.data.session.compact({ sessionID: item.sessionID }).catch(() => undefined)
    response.resolve(Response.json({ data: [canonical] }))
    await reading
    expect(setup.data.session.pending.list(item.sessionID)).toEqual([canonical])
    admission.reject(new Error("Connection closed"))
    await compacting
    expect(setup.data.session.pending.list(item.sessionID)).toEqual([canonical])
  } finally {
    response.resolve(Response.json({ data: [] }))
    admission.resolve(new Response(null, { status: 204 }))
    setup.dispose()
  }
})

const transcript = {
  data: [{ id: item.id, type: "user", text: "Check the remote preview", time: { created: 2 } }],
  cursor: {},
}

test("a transcript read clears a prompt whose delivery event was missed", async () => {
  const setup = fixture(async (request) =>
    new URL(request.url).pathname.endsWith("/message") ? Response.json(transcript) : Response.json({ data: [] }),
  )
  try {
    setup.emit(enqueued)
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(true)
    await setup.data.session.message.sync(item.sessionID)
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(false)
    expect(setup.data.session.message.get(item.sessionID, item.id)?.time.created).toBe(2)
  } finally {
    setup.dispose()
  }
})

test("a transcript read clears an accepted prompt whose events were all missed", async () => {
  const setup = fixture(async (request) => {
    if (request.method === "POST") return Response.json({ data: { id: item.id } })
    if (new URL(request.url).pathname.endsWith("/message")) return Response.json(transcript)
    return Response.json({ data: [] })
  })
  try {
    await setup.data.session.prompt({ sessionID: item.sessionID, id: item.id, text: item.payload.text })
    // An inbox read cannot see a prompt the server already delivered, so it keeps the outbox row.
    await setup.data.session.pending.sync(item.sessionID)
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(true)
    await setup.data.session.message.sync(item.sessionID)
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(false)
    // Later inbox reads no longer resurrect it from the outbox.
    await setup.data.session.pending.sync(item.sessionID)
    expect(setup.data.session.input.has(item.sessionID, item.id)).toBe(false)
  } finally {
    setup.dispose()
  }
})
