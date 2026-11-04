export * as SessionModelTransport from "./model-transport.js"

import {
  WebSocketTransport,
  type ChannelObservation,
  type ChannelCheckpoint,
  type WebSocketChannelDriver,
  type WebSocketChannelExchange,
  type WebSocketChannelExecution,
  type WebSocketChannelExecutor,
  type WebSocketConnection,
  type WebSocketConnector,
} from "@opencode/ai/route"
import { AIError, AIErrorReason, TransportError, type TransportOperation } from "@opencode/ai/effect"
import { Hash } from "@opencode/util/hash"
import { Cause, Clock, Context, Duration, Effect, Fiber, Layer, Metric, Queue, Scope, Semaphore, Stream } from "effect"
import { Headers } from "effect/http"
import { Socket } from "effect/socket"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionSchema } from "./schema.js"
import { SessionNativeTest } from "./native-test.js"
import { webSocketConstructor } from "../effect/app-node-platform.js"

const ROTATE_AFTER_MS = 55 * 60 * 1000
const CONNECT_TIMEOUT = "15 seconds"
const IDLE_TIMEOUT = "30 minutes"
const MAX_STREAM_FAILURES = 5
const events = Metric.counter("opencode_session_websocket_events_total", {
  description: "Session WebSocket lifecycle events",
  incremental: true,
})
const metric = (event: string, attributes: Record<string, string> = {}) =>
  Metric.update(events.pipe(Metric.withAttributes({ event, ...attributes })), 1)

interface Active {
  readonly queue: Queue.Queue<string, AIError>
  driver: WebSocketChannelDriver
  delivery: "send-attempted" | "provider-observed" | "terminal"
}
interface Channel {
  readonly affinity: string
  readonly connection: WebSocketConnection
  readonly openedAt: number
  active?: Active
  closing: boolean
  checkpoint?: ChannelCheckpoint
  pending?: { readonly token: object; readonly checkpoint: ChannelCheckpoint }
  reader?: Fiber.Fiber<unknown, unknown>
  continuation?: string
}
interface State {
  readonly sessionID: SessionSchema.ID
  readonly lock: Semaphore.Semaphore
  closed: boolean
  httpFallback: boolean
  streamFailures: number
  channel?: Channel
  generation?: number
}
export type Lane = Pick<SessionNativeTest.Interface, "generation" | "observe">
export interface Handshake {
  readonly url: string
  readonly headers: Record<string, string>
}
export interface Interceptor {
  readonly handshake?: (connect: Handshake) => Effect.Effect<Handshake>
  readonly send?: (frame: string) => Effect.Effect<string, AIError>
  readonly receive?: (frame: string) => Effect.Effect<string>
}
export interface Interface {
  readonly bind: (
    sessionID: SessionSchema.ID,
    interceptor?: Interceptor,
    idleTimeout?: number | false,
  ) => WebSocketChannelExecutor
  readonly close: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly retire: (sessionID: SessionSchema.ID, generation: number) => Effect.Effect<void>
  readonly closeAll: Effect.Effect<void>
  readonly steer: (sessionID: SessionSchema.ID, text: string, admit: Effect.Effect<void>) => Effect.Effect<boolean>
  readonly hasPendingInput: (sessionID: SessionSchema.ID) => boolean
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelTransport") {}

const transportError = (
  message: string,
  input: {
    readonly operation: TransportOperation
    readonly url?: string
    readonly code?: string
    readonly phase?: TransportError["phase"]
    readonly delivery?: TransportError["delivery"]
  },
) => new AIError({ reason: new TransportError({ message, transport: "websocket", ...input }) })
const affinity = (exchange: WebSocketChannelExchange) =>
  `${exchange.connect.url}:${Hash.sha256(JSON.stringify(Object.entries(exchange.connect.headers).sort(([a], [b]) => a.localeCompare(b))))}`
// Keep backend text out of metadata-only diagnostics.
const closeCode = (error: AIError) =>
  error.reason._tag === "Transport" && typeof error.reason.code === "string" && /^[0-9]{4}$/.test(error.reason.code)
    ? Number(error.reason.code)
    : undefined
const annotate = (error: AIError, phase: TransportError["phase"], delivery: TransportError["delivery"]) =>
  error.reason._tag !== "Transport"
    ? error
    : new AIError({
        reason: new TransportError({
          ...error.reason,
          message: error.message,
          cause: error.reason.cause,
          phase,
          delivery,
        }),
      })
const observationTerminal = (
  observation: ChannelObservation,
): observation is Exclude<ChannelObservation, { type: "frame" | "ignore" }> =>
  observation.type !== "frame" && observation.type !== "ignore"
const observationFrame = (observation: ChannelObservation) => {
  if (observation.type === "ignore") return Effect.die("Ignored channel event reached the parser")
  if (observation.type === "frame" || observation.type === "completed" || observation.type === "incomplete")
    return Effect.succeed(observation.frame)
  return Effect.fail(observation.error)
}

export const makeLayer = (connector: WebSocketConnector, lane?: Lane) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const states = new Map<SessionSchema.ID, State>()
      const note = (owner: State, fact: SessionNativeTest.Fact) => {
        try {
          lane?.observe(owner.sessionID, fact)
        } catch {
          /* Diagnostics cannot alter delivery. */
        }
      }
      const state = (sessionID: SessionSchema.ID) => {
        const current = states.get(sessionID)
        if (current) return current
        const created: State = {
          sessionID,
          lock: Semaphore.makeUnsafe(1),
          closed: false,
          httpFallback: false,
          streamFailures: 0,
        }
        states.set(sessionID, created)
        return created
      }
      const closeChannel = Effect.fn("SessionModelTransport.closeChannel")(function* (owner: State, channel: Channel) {
        if (owner.channel === channel) owner.channel = undefined
        if (channel.closing) return
        channel.closing = true
        if (channel.reader) yield* Fiber.interrupt(channel.reader)
        if (channel.active)
          Queue.failCauseUnsafe(
            channel.active.queue,
            Cause.fail(
              transportError("Session WebSocket closed", {
                operation: "read",
                code: "close",
                phase: "close",
                delivery: channel.active.delivery === "send-attempted" ? "ambiguous" : "accepted",
              }),
            ),
          )
        yield* channel.connection.close
        yield* metric("close")
        note(owner, { kind: "closed" })
      })
      const poison = Effect.fn("SessionModelTransport.poison")(function* (
        owner: State,
        channel: Channel,
        error: AIError,
      ) {
        if (owner.channel === channel) owner.channel = undefined
        if (channel.closing) return
        channel.closing = true
        yield* Effect.logDebug("session websocket poisoned", {
          sessionTransport: "websocket",
          code: error.reason._tag === "Transport" ? error.reason.code : error.reason._tag,
          active: channel.active !== undefined,
        })
        if (channel.active) {
          Queue.failCauseUnsafe(channel.active.queue, Cause.fail(error))
          yield* streamFailure(owner)
        }
        yield* metric("protocol_failure")
        const code = closeCode(error)
        note(owner, {
          kind: "poisoned",
          category: code === undefined ? "transport" : "peer-close",
          ...(code === undefined ? {} : { closeCode: code }),
        })
        yield* channel.connection.close
      })
      // Repeated lost exchanges pin the Session to HTTP rather than charging a retry every step.
      const streamFailure = Effect.fn("SessionModelTransport.streamFailure")(function* (owner: State) {
        owner.streamFailures++
        if (owner.streamFailures < MAX_STREAM_FAILURES) return
        owner.httpFallback = true
        yield* Effect.logWarning("session websocket failed repeatedly; using http", {
          sessionTransport: "websocket",
          failures: owner.streamFailures,
        })
        yield* metric("fallback", { reason: "stream_failures" })
        note(owner, { kind: "fallback", category: "stream-failures" })
      })
      const retireStale = Effect.fn("SessionModelTransport.retireStale")(function* (owner: State, generation: number) {
        if (owner.generation !== undefined && owner.generation !== generation) {
          if (owner.channel) yield* closeChannel(owner, owner.channel)
          owner.httpFallback = false
          owner.streamFailures = 0
          note(owner, { kind: "channel-retired" })
        }
        owner.generation = generation
      })
      const retire = Effect.fn("SessionModelTransport.retire")(function* (
        sessionID: SessionSchema.ID,
        generation: number,
      ) {
        const owner = states.get(sessionID)
        if (owner && !owner.closed) yield* owner.lock.withPermits(1)(retireStale(owner, generation))
      })
      const open = Effect.fn("SessionModelTransport.open")(function* (
        owner: State,
        exchange: WebSocketChannelExchange,
        key: string,
      ) {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const connection = yield* restore(
              connector.open(exchange.connect).pipe(
                Effect.timeoutOrElse({
                  duration: CONNECT_TIMEOUT,
                  orElse: () =>
                    transportError("Timed out opening the Session WebSocket", {
                      url: exchange.connect.url,
                      operation: "request",
                      code: "connect-timeout",
                      phase: "connect",
                      delivery: "not-sent",
                    }),
                }),
                Effect.withSpan("SessionModelTransport.connect"),
              ),
            )
            if (owner.closed) {
              yield* connection.close
              return yield* transportError("Session WebSocket owner closed while connecting", {
                url: exchange.connect.url,
                operation: "request",
                code: "owner-closed",
                phase: "connect",
                delivery: "not-sent",
              })
            }
            const channel: Channel = {
              affinity: key,
              connection,
              openedAt: yield* Clock.currentTimeMillis,
              closing: false,
            }
            owner.channel = channel
            channel.reader = yield* connection.messages.pipe(
              Stream.runForEach((message) =>
                Effect.gen(function* () {
                  const active = channel.active
                  if (!active)
                    return yield* transportError("WebSocket data arrived without an active exchange", {
                      url: exchange.connect.url,
                      operation: "read",
                      code: "idle-data",
                      phase: "receive",
                    })
                  active.delivery = "provider-observed"
                  if (typeof message !== "string")
                    return yield* transportError("Unsupported binary WebSocket frame", {
                      url: exchange.connect.url,
                      operation: "read",
                      code: "message",
                      phase: "receive",
                    })
                  Queue.offerUnsafe(active.queue, message)
                }),
              ),
              Effect.catch((error) =>
                channel.closing
                  ? Effect.void
                  : poison(
                      owner,
                      channel,
                      annotate(
                        error,
                        error.reason._tag === "Transport" && error.reason.phase === "close" ? "close" : "receive",
                        channel.active?.delivery === "provider-observed" || channel.active?.delivery === "terminal"
                          ? "accepted"
                          : error.reason._tag === "Transport" && error.reason.code === "1009"
                            ? "rejected"
                            : "ambiguous",
                      ),
                    ),
              ),
              Effect.forkIn(scope, { startImmediately: true }),
            )
            yield* Effect.logDebug("session websocket connected", {
              sessionTransport: "websocket",
              phase: "connect",
            })
            yield* metric("connect")
            note(owner, { kind: "connect" })
            return channel
          }),
        )
      })
      const fallback = (exchange: WebSocketChannelExchange): WebSocketChannelExecution => ({
        frames: exchange.fallback(),
        complete: Effect.void,
      })
      const start = Effect.fn("SessionModelTransport.start")(function* (
        owner: State,
        input: WebSocketChannelExchange,
        interceptor?: Interceptor,
        idleTimeout?: number | false,
      ): Effect.fn.Return<WebSocketChannelExecution, AIError> {
        if (owner.closed)
          return yield* transportError("Session WebSocket owner is closed", {
            operation: "request",
            code: "owner-closed",
            phase: "queue",
            delivery: "not-sent",
          })
        yield* retireStale(owner, lane?.generation(owner.sessionID) ?? 0)
        if (owner.httpFallback) return fallback(input)
        const selected = interceptor?.handshake
          ? yield* interceptor.handshake({ url: input.connect.url, headers: { ...input.connect.headers } })
          : undefined
        const exchange = selected
          ? { ...input, connect: { ...input.connect, url: selected.url, headers: Headers.fromInput(selected.headers) } }
          : input
        const key = affinity(exchange)
        // Outer parsing did not commit this exchange; its successor may still be streaming.
        if (owner.channel?.pending) yield* closeChannel(owner, owner.channel)
        const current = owner.channel
        const now = yield* Clock.currentTimeMillis
        const rotation = current
          ? current.affinity !== key
            ? "affinity"
            : now - current.openedAt >= (exchange.connect.rotateAfterMs ?? ROTATE_AFTER_MS)
              ? "age"
              : undefined
          : undefined
        if (current && rotation) {
          yield* Effect.logDebug("session websocket rotating", {
            sessionTransport: "websocket",
            phase: "connect",
            reason: rotation,
          })
          yield* metric("rotation", { reason: rotation })
          note(owner, { kind: "rotate", category: rotation })
          yield* metric("reconnect")
          yield* closeChannel(owner, current)
        }
        if (owner.channel) {
          yield* Effect.logDebug("session websocket reused", {
            sessionTransport: "websocket",
            phase: "connect",
          })
          yield* metric("reuse")
          note(owner, { kind: "reuse" })
        }
        const channel =
          owner.channel ??
          (yield* open(owner, exchange, key).pipe(
            Effect.catch((error) => {
              if (error.reason._tag === "Transport" && error.reason.code === "owner-closed") return Effect.fail(error)
              owner.httpFallback = true
              note(owner, { kind: "connect-failed", category: "connect-failure" })
              return Effect.logWarning("session websocket connect failed; using http", {
                sessionTransport: "websocket",
                phase: "connect",
                delivery: "not-sent",
                code: error.reason._tag === "Transport" ? error.reason.code : error.reason._tag,
              }).pipe(
                Effect.andThen(metric("connect_failure")),
                Effect.andThen(metric("fallback")),
                Effect.as(undefined),
              )
            }),
          ))
        if (!channel) return fallback(exchange)
        const create = yield* exchange.driver.create(channel.checkpoint).pipe(
          Effect.tapError(() => closeChannel(owner, channel)),
          Effect.onInterrupt(() => closeChannel(owner, channel)),
        )
        if (channel.continuation && create.mode !== "automatic") {
          yield* closeChannel(owner, channel)
          return yield* start(owner, input, interceptor, idleTimeout)
        }
        if (create.mode === "full") channel.checkpoint = undefined
        const carried = channel.continuation
        const active: Active =
          create.mode === "automatic" && channel.active
            ? channel.active
            : {
                queue: yield* Queue.unbounded<string, AIError>(),
                driver: exchange.driver,
                delivery: "send-attempted",
              }
        active.driver = exchange.driver
        channel.active = active
        channel.continuation = undefined
        yield* Effect.logDebug("session websocket sending", {
          sessionTransport: "websocket",
          phase: "send",
          mode: create.mode,
        })
        const sent = yield* (
          create.mode === "automatic"
            ? Effect.void
            : Effect.gen(function* () {
                const message = interceptor?.send ? yield* interceptor.send(create.message) : create.message
                yield* channel.connection.sendText(message)
              })
        ).pipe(
          Effect.withSpan("SessionModelTransport.send"),
          Effect.onInterrupt(() => closeChannel(owner, channel)),
          Effect.result,
        )
        if (sent._tag === "Failure") {
          if (!(sent.failure instanceof AIError) || sent.failure.reason._tag !== "Transport") {
            yield* closeChannel(owner, channel)
            return yield* Effect.fail(sent.failure)
          }
          const notSent = sent.failure.reason._tag === "Transport" && sent.failure.reason.delivery === "not-sent"
          yield* closeChannel(owner, channel)
          if (notSent) {
            yield* metric("fallback")
            note(owner, { kind: "send-not-sent", category: "not-sent" })
            return fallback(exchange)
          }
          yield* metric("ambiguous_delivery")
          note(owner, { kind: "send-ambiguous" })
          yield* streamFailure(owner)
          return yield* annotate(
            new AIError({
              reason: AIErrorReason.make({
                ...sent.failure.reason,
                message: sent.failure.message,
                cause: sent.failure.reason.cause,
                http: sent.failure.reason.http ?? channel.connection.http,
              }),
            }),
            "send",
            "ambiguous",
          )
        }
        note(owner, { kind: create.mode === "automatic" ? "adopt" : "send" })
        yield* metric("send")
        let terminal: Exclude<ChannelObservation, { type: "frame" | "ignore" }> | undefined
        const token = {}
        // A chunk can contain both the parent's terminal and the successor's response.created.
        const inbound = Stream.fromEffectRepeat(Queue.take(active.queue))
        const frames = (
          create.mode === "automatic" && carried ? Stream.concat(Stream.succeed(carried), inbound) : inbound
        ).pipe(
          Stream.timeoutOrElse({
            duration: idleTimeout === false ? Duration.infinity : (idleTimeout ?? IDLE_TIMEOUT),
            orElse: () =>
              Stream.fail(
                transportError("Timed out waiting for WebSocket data", {
                  url: exchange.connect.url,
                  operation: "read",
                  code: "idle-timeout",
                  phase: "receive",
                  delivery: active.delivery === "send-attempted" ? "ambiguous" : "accepted",
                }),
              ),
          }),
          Stream.mapEffect((frame) => (interceptor?.receive ? interceptor.receive(frame) : Effect.succeed(frame))),
          Stream.mapEffect((frame) => exchange.driver.observe(create, frame)),
          Stream.tap((observation) =>
            Effect.sync(() => {
              if (!observationTerminal(observation)) return
              terminal = observation
              active.delivery = "terminal"
              const staged =
                observation.type === "completed" || observation.type === "incomplete"
                  ? observation.checkpoint
                  : undefined
              if (staged) channel.pending = { token, checkpoint: staged }
              if (!staged) channel.checkpoint = undefined
              if (observation.type === "completed" || observation.type === "incomplete")
                channel.continuation = observation.continuation
            }),
          ),
          Stream.takeUntil(observationTerminal),
          Stream.filter((observation) => observation.type !== "ignore"),
          Stream.mapEffect(observationFrame),
          Stream.ensuring(
            Effect.gen(function* () {
              if (channel.continuation) return
              if (channel.active === active) channel.active = undefined
              const pending = yield* Queue.size(active.queue)
              yield* Queue.shutdown(active.queue)
              if (terminal && pending === 0) {
                owner.streamFailures = 0
                yield* metric("terminal", { type: terminal.type })
                if (terminal.type === "rejected") yield* metric("rejection", { recovery: terminal.recovery })
                note(owner, {
                  kind: "terminal",
                  category: terminal.type,
                })
                if (terminal.type !== "completed" && terminal.type !== "incomplete") yield* closeChannel(owner, channel)
                return
              }
              yield* metric("cancellation")
              channel.checkpoint = undefined
              channel.pending = undefined
              yield* poison(
                owner,
                channel,
                terminal
                  ? transportError("WebSocket data arrived after the terminal event", {
                      url: exchange.connect.url,
                      operation: "read",
                      code: "idle-data",
                      phase: "receive",
                      delivery: "accepted",
                    })
                  : transportError("Session WebSocket exchange did not reach a terminal event", {
                      url: exchange.connect.url,
                      operation: "read",
                      code: "incomplete",
                      phase: "receive",
                      delivery: active.delivery === "send-attempted" ? "ambiguous" : "accepted",
                    }),
              )
            }),
          ),
          Stream.catch((error) => {
            if (
              create.mode === "automatic" ||
              error.reason._tag !== "Transport" ||
              error.reason.code !== "1009" ||
              error.reason.delivery !== "rejected"
            )
              return Stream.fail(error)
            owner.httpFallback = true
            return Stream.unwrap(
              Effect.logWarning("session websocket request too large; using http", {
                sessionTransport: "websocket",
                phase: "close",
                delivery: "rejected",
                code: error.reason.code,
              }).pipe(
                Effect.andThen(metric("fallback", { reason: "message_too_large" })),
                Effect.tap(() => Effect.sync(() => note(owner, { kind: "fallback", category: "message-too-large" }))),
                Effect.as(exchange.fallback()),
              ),
            )
          }),
        )
        return {
          frames,
          http: channel.connection.http,
          complete: Effect.sync(() => {
            if (owner.channel !== channel || channel.pending?.token !== token) return
            channel.checkpoint = channel.pending.checkpoint
            channel.pending = undefined
          }),
        }
      })
      const bind = (
        sessionID: SessionSchema.ID,
        interceptor?: Interceptor,
        idleTimeout?: number | false,
      ): WebSocketChannelExecutor => ({
        execute: (exchange) => {
          const owner = state(sessionID)
          let execution: WebSocketChannelExecution | undefined
          return Effect.succeed({
            get http() {
              return execution?.http
            },
            frames: Stream.unwrap(
              Effect.acquireRelease(owner.lock.take(1), () => owner.lock.release(1), { interruptible: true }).pipe(
                Effect.andThen(start(owner, exchange, interceptor, idleTimeout)),
                Effect.tap((started) =>
                  Effect.sync(() => {
                    execution = started
                  }),
                ),
                Effect.map((started) => started.frames),
              ),
            ),
            complete: Effect.suspend(() => execution?.complete ?? Effect.void),
          })
        },
      })
      const steer = Effect.fn("SessionModelTransport.steer")(function* (
        sessionID: SessionSchema.ID,
        text: string,
        admit: Effect.Effect<void>,
      ) {
        const owner = states.get(sessionID)
        const channel = owner?.channel
        const active = channel?.active
        if (!owner || !channel || channel.closing || !active?.driver.steer) return false
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const message = yield* active.driver.steer!(text).pipe(Effect.orElseSucceed(() => undefined))
            if (!message) return false
            yield* admit
            yield* restore(channel.connection.sendText(message)).pipe(
              Effect.catch((error) => poison(owner, channel, error)),
              Effect.onInterrupt(() => closeChannel(owner, channel)),
            )
            return true
          }),
        )
      })
      const close = Effect.fn("SessionModelTransport.close")(function* (sessionID: SessionSchema.ID) {
        const owner = states.get(sessionID)
        if (!owner) return
        states.delete(sessionID)
        owner.closed = true
        if (owner.channel) yield* closeChannel(owner, owner.channel)
      })
      const closeAll = Effect.suspend(() => {
        const owners = Array.from(states.values())
        states.clear()
        return Effect.forEach(
          owners,
          (owner) => {
            owner.closed = true
            return owner.channel ? closeChannel(owner, owner.channel) : Effect.void
          },
          { discard: true },
        )
      })
      yield* Effect.addFinalizer(() => closeAll)
      return Service.of({
        bind,
        close,
        closeAll,
        retire,
        steer,
        hasPendingInput: (sessionID) => {
          const channel = states.get(sessionID)?.channel
          return channel?.continuation !== undefined || channel?.checkpoint?.pendingInput === true
        },
      })
    }),
  )

export const layer = Layer.unwrap(
  Effect.map(Socket.WebSocketConstructor, (constructor) =>
    makeLayer({
      open: (input) =>
        WebSocketTransport.open(input).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor)),
    }),
  ),
)
export const node = makeGlobalNode({ service: Service, layer, deps: [webSocketConstructor] })
