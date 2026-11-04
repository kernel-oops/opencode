import { describe, expect, test } from "bun:test"
import type { AIError } from "@opencode/ai/effect"
import type {
  ChannelObservation,
  WebSocketChannelExchange,
  WebSocketConnection,
  WebSocketConnector,
} from "@opencode/ai/route"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionNativeTest } from "@opencode/core/session/native-test"
import { SessionNativeTest as Contract } from "@opencode/schema/session-native-test"
import { Session } from "@opencode/schema/session"
import { Effect, Exit, Queue, Schema, Stream } from "effect"
import { Headers } from "effect/http"

const a = Session.ID.make("ses_native_test_a")
const b = Session.ID.make("ses_native_test_b")
const child = Session.ID.make("ses_native_test_a_child")
const on = { nativeSteer: "response.steer", debug: "metadata" } as const

const exchange = (id: string): WebSocketChannelExchange => ({
  id,
  // Identical endpoint and secret-bearing headers for every session in these tests.
  connect: { url: "wss://provider.test/responses?key=url-secret", headers: Headers.fromInput({ authorization: "Bearer header-secret" }) },
  fallback: () => Stream.make(`fallback:${id}`),
  driver: {
    create: () => Effect.succeed({ message: `prompt-secret:${id}`, mode: "full" }),
    observe: (_create, frame): Effect.Effect<ChannelObservation, AIError> => Effect.succeed({ type: "completed", frame }),
  },
})

const automatic = () => {
  const connections: Array<{ closed: number; sent: string[] }> = []
  const connector: WebSocketConnector = {
    open: () =>
      Effect.gen(function* () {
        const messages = yield* Queue.unbounded<string | Uint8Array, AIError>()
        const record = { closed: 0, sent: [] as string[] }
        connections.push(record)
        const connection: WebSocketConnection = {
          sendText: (message) =>
            Effect.sync(() => {
              record.sent.push(message)
              Queue.offerUnsafe(messages, `completed:${message}`)
            }),
          messages: Stream.fromQueue(messages),
          close: Effect.sync(() => {
            record.closed++
          }).pipe(Effect.andThen(Queue.shutdown(messages)), Effect.asVoid),
        }
        return connection
      }),
  }
  return { connector, connections }
}

const collect = (executor: ReturnType<SessionModelTransport.Interface["bind"]>, item: WebSocketChannelExchange) =>
  Effect.gen(function* () {
    const execution = yield* executor.execute(item)
    return Array.from(yield* Stream.runCollect(execution.frames.pipe(Stream.onEnd(execution.complete))))
  }).pipe(Effect.scoped)

const run = <A, E>(connector: WebSocketConnector, lane: SessionModelTransport.Lane, effect: Effect.Effect<A, E, SessionModelTransport.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SessionModelTransport.makeLayer(connector, lane)), Effect.scoped))

describe("SessionNativeTest registry", () => {
  test("is off by default and holds one exact session lane at a time", async () => {
    const registry = SessionNativeTest.make()
    expect(registry.policy(a)).toEqual(Contract.off)
    expect(registry.inspect(a)).toMatchObject({ requested: Contract.off, effective: Contract.off, pending: false })
    await Effect.runPromise(registry.request(a, on))
    const occupied = await Effect.runPromise(registry.request(b, { nativeSteer: false, debug: "metadata" }).pipe(Effect.exit))
    expect(Exit.isFailure(occupied)).toBe(true)
    // Requests are inert until an execution snapshots them; other IDs (children, forks, imports) stay off.
    expect(registry.policy(a)).toEqual(Contract.off)
    await Effect.runPromise(registry.start(a))
    expect(registry.policy(a)).toEqual(on)
    expect(registry.policy(child)).toEqual(Contract.off)
    expect(registry.policy(b)).toEqual(Contract.off)
    await Effect.runPromise(registry.request(b, Contract.off))
    // Opting out while busy is pending; the running execution keeps its snapshot and occupies the lane.
    await Effect.runPromise(registry.request(a, Contract.off))
    expect(registry.inspect(a)).toMatchObject({ requested: Contract.off, effective: on, pending: true })
    expect(registry.policy(a)).toEqual(on)
    expect(Exit.isFailure(await Effect.runPromise(registry.request(b, on).pipe(Effect.exit)))).toBe(true)
    await Effect.runPromise(registry.finish(a))
    expect(registry.policy(a)).toEqual(Contract.off)
    await Effect.runPromise(registry.request(b, on))
    expect(registry.inspect(b).requested).toEqual(on)
  })

  test("each execution change has a new generation and an off lane is forgotten after it runs off", async () => {
    const registry = SessionNativeTest.make()
    await Effect.runPromise(registry.request(a, on))
    await Effect.runPromise(registry.start(a))
    const first = registry.generation(a)
    expect(first).toBeGreaterThan(0)
    await Effect.runPromise(registry.finish(a))
    await Effect.runPromise(registry.request(a, { nativeSteer: false, debug: "metadata" }))
    await Effect.runPromise(registry.request(a, on))
    await Effect.runPromise(registry.start(a))
    expect(registry.generation(a)).not.toBe(first)
    await Effect.runPromise(registry.finish(a))
    await Effect.runPromise(registry.request(a, Contract.off))
    await Effect.runPromise(registry.start(a))
    expect(registry.policy(a)).toEqual(Contract.off)
    await Effect.runPromise(registry.finish(a))
    expect(registry.inspect(a).execution).toBeUndefined()
  })

  test("a restart is a fresh registry with no requests and a new server-run identity", async () => {
    const before = SessionNativeTest.make()
    await Effect.runPromise(before.request(a, on))
    const after = SessionNativeTest.make()
    expect(after.serverRun).not.toBe(before.serverRun)
    expect(after.inspect(a).requested).toEqual(Contract.off)
  })

  test("diagnostics are debug-gated and ring-bounded without progress bookkeeping", async () => {
    const registry = SessionNativeTest.make(() => 1_000)
    await Effect.runPromise(registry.request(a, { nativeSteer: "response.steer", debug: false }))
    await Effect.runPromise(registry.start(a))
    registry.observe(a, { kind: "connect" })
    expect(registry.inspect(a).diagnostics.records).toEqual([])
    await Effect.runPromise(registry.finish(a))
    await Effect.runPromise(registry.request(a, on))
    await Effect.runPromise(registry.start(a))
    for (let index = 0; index < SessionNativeTest.RING_SIZE + 44; index++) registry.observe(a, { kind: "send" })
    const bounded = registry.inspect(a).diagnostics
    expect(bounded.records).toHaveLength(SessionNativeTest.RING_SIZE)
    expect(bounded.dropped).toBe(44 + 1)
    expect(bounded.progress).toBe(0)
    expect(bounded.coalesced).toBe(0)
    expect(bounded.records.at(-1)?.exchange).toBe(SessionNativeTest.RING_SIZE + 44)
    expect(registry.inspect(b).diagnostics.records).toEqual([])
  })
})

describe("SessionNativeTest transport lane", () => {
  test("only the selected session retires and reconnects; another session with the same endpoint keeps its socket", async () => {
    const registry = SessionNativeTest.make()
    const sockets = automatic()
    await run(sockets.connector, registry, Effect.gen(function* () {
      const transport = yield* SessionModelTransport.Service
      yield* collect(transport.bind(a), exchange("a1"))
      yield* collect(transport.bind(b), exchange("b1"))
      expect(sockets.connections).toHaveLength(2)
      yield* registry.request(a, on)
      yield* registry.start(a)
      yield* collect(transport.bind(a), exchange("a2"))
      yield* collect(transport.bind(b), exchange("b2"))
      expect(sockets.connections).toHaveLength(3)
      expect(sockets.connections[0]!.closed).toBe(1)
      expect(sockets.connections[1]!.closed).toBe(0)
      expect(sockets.connections[1]!.sent).toEqual(["prompt-secret:b1", "prompt-secret:b2"])
      const records = registry.inspect(a).diagnostics.records
      expect(records.map((record) => record.kind)).toEqual(["execution-started", "closed", "channel-retired", "connect", "send", "terminal"])
      expect(records.at(-1)?.category).toBe("completed")
      expect(registry.inspect(b).diagnostics.records).toEqual([])
      // Metadata only: no URL, headers, prompts, frames or arbitrary strings.
      const serialised = JSON.stringify(records)
      for (const secret of ["provider.test", "url-secret", "header-secret", "prompt-secret", "completed:"])
        expect(serialised).not.toContain(secret)
      expect(() => records.forEach((record) => Schema.decodeUnknownSync(Contract.Record)(record))).not.toThrow()
    }))
  })

  test("ordinary exchanges retain their session socket", async () => {
    const sockets = automatic()
    await run(sockets.connector, SessionNativeTest.make(), Effect.gen(function* () {
      const transport = yield* SessionModelTransport.Service
      yield* collect(transport.bind(a), exchange("ordinary"))
      yield* collect(transport.bind(a), exchange("next"))
      expect(sockets.connections).toHaveLength(1)
      expect(sockets.connections[0]!.closed).toBe(0)
      expect(sockets.connections[0]!.sent).toEqual(["prompt-secret:ordinary", "prompt-secret:next"])
    }))
  })

  test("an observer failure cannot alter settlement", async () => {
    const sockets = automatic()
    const lane: SessionModelTransport.Lane = {
      generation: () => 0,
      observe: () => {
        throw new Error("observer failed")
      },
    }
    const frames = await run(sockets.connector, lane, Effect.gen(function* () {
      const transport = yield* SessionModelTransport.Service
      return [yield* collect(transport.bind(a), exchange("first")), yield* collect(transport.bind(a), exchange("second"))]
    }))
    expect(frames).toEqual([["completed:prompt-secret:first"], ["completed:prompt-secret:second"]])
    expect(sockets.connections).toHaveLength(1)
  })
})
