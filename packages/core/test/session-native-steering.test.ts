import { expect } from "bun:test"
import { AIError, ai, TransportError } from "@opencode/ai/effect"
import { OpenAIResponses } from "@opencode/ai/protocols"
import { LLMClient, RequestExecutor, type WebSocketConnector } from "@opencode/ai/route"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStep } from "@opencode/core/session/runner/step"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { Snapshot } from "@opencode/core/snapshot"
import { ToolOutput } from "@opencode/core/tool-output"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Cause, Effect, Layer, Queue, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { testEffect } from "./lib/effect"
import { handlerLayer, runtimeLayer } from "../../ai/test/lib/http"

const runtime = Layer.mergeAll(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
  LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer)),
  Layer.mock(Snapshot.Service)({ capture: () => Effect.succeed(undefined) }),
)
const it = testEffect(runtime)
type Mode =
  | "steered"
  | "natural"
  | "pending"
  | "steering_not_supported"
  | "too_many_pending_steers"
  | "response_not_found"
  | "disconnect"
  | "successor"
  | "unsupported"

const setup = (mode: Mode, id = "gpt-6-sol") =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const inbox = yield* SessionInbox.make()
    const sessionID = Session.ID.create()
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/fixture"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "steering",
        directory: "/fixture",
        version: "test",
      })
      .run()
    const admit = (text: string) =>
      inbox
        .admit({
          id: SessionMessage.ID.create(),
          sessionID,
          item: { type: "user", delivery: "steer", payload: { text } },
        })
        .pipe(Effect.orDie)
    yield* admit("Original")
    const bus = yield* Bus.Service
    yield* SessionInbox.promote(db, bus, sessionID, "input")
    const history = Effect.gen(function* () {
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
      return yield* SessionHistory.decodeMessageRows(db, rows)
    })
    const route = OpenAIResponses.route.with({
      endpoint: { baseURL: "https://fixture.invalid/v1" },
      transport: OpenAIResponses.nativeSteerTransport,
    })
    const model = SessionRunnerModel.resolved(route.model({ id }), {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 1_000 },
      cost: [],
    })
    const frames: Array<Record<string, unknown>> = []
    let resets = 0
    let messages = yield* Queue.unbounded<string | Uint8Array, AIError | Cause.Done>()
    const emit = (event: unknown) => Queue.offer(messages, JSON.stringify(event)).pipe(Effect.asVoid)
    const item = {
      type: "message",
      id: "msg_parent",
      role: "assistant",
      content: [{ type: "output_text", text: "Parent" }],
    }
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" }
    let opens = 0
    let tools = 0
    let persistedAtSend = false
    const connector: WebSocketConnector = {
      open: () =>
        Effect.gen(function* () {
          if (opens > 0) messages = yield* Queue.unbounded<string | Uint8Array, AIError | Cause.Done>()
          opens++
          return {
            messages: Stream.fromQueue(messages),
            close: Effect.void,
            sendText: (text) =>
              Effect.gen(function* () {
                const frame = JSON.parse(text) as Record<string, unknown>
                frames.push(frame)
                if (frame.type === "response.steer") {
                  persistedAtSend = (yield* history.pipe(Effect.orDie)).some(
                    (message) => message.type === "user" && message.text === "Correction",
                  )
                  const parent = String(frame.previous_response_id)
                  const steer = { id: parent === "resp_1" ? "steer_1" : "steer_2", previous_response_id: parent }
                  if (["steering_not_supported", "too_many_pending_steers", "response_not_found"].includes(mode)) {
                    yield* emit({
                      type: "response.steer.failed",
                      steer: { ...steer, input: frame.input },
                      error: { type: "invalid_request_error", code: mode, message: "Rejected" },
                    })
                    yield* emit({ type: "response.completed", response: { id: parent, output: [item] } })
                    return
                  }
                  yield* emit({ type: "response.steer.accepted", steer })
                  if (mode === "disconnect") {
                    yield* Queue.fail(
                      messages,
                      new AIError({
                        reason: new TransportError({
                          message: "closed",
                          transport: "websocket",
                          operation: "read",
                          phase: "close",
                          code: "1006",
                        }),
                      }),
                    )
                    return
                  }
                  if (mode === "pending") {
                    yield* emit({ type: "response.output_item.done", item: call })
                    yield* emit({ type: "response.completed", response: { id: parent, output: [item, call] } })
                    yield* emit({
                      type: "response.steer.pending",
                      steer,
                      reason: "waiting_for_required_input",
                      required_input: [{ type: "function_call_output", call_id: "call_1", name: "lookup" }],
                    })
                    return
                  }
                  yield* emit({
                    type: mode === "natural" ? "response.completed" : "response.incomplete",
                    response: {
                      id: parent,
                      output: [item],
                      incomplete_details: mode === "natural" ? undefined : { reason: "steered" },
                    },
                  })
                  yield* emit({ type: "response.created", response: { id: parent === "resp_1" ? "resp_2" : "resp_3" } })
                  yield* emit({ type: "response.output_item.added", item: { ...item, id: "msg_successor" } })
                  yield* emit({ type: "response.output_text.delta", item_id: "msg_successor", delta: "Successor" })
                  if (mode === "successor" && parent === "resp_1") return
                  yield* emit({
                    type: "response.completed",
                    response: { id: parent === "resp_1" ? "resp_2" : "resp_3", output: [] },
                  })
                  return
                }
                const creates = frames.filter((entry) => entry.type === "response.create").length
                if (creates > 1) {
                  yield* emit({ type: "response.created", response: { id: "resp_explicit" } })
                  yield* emit({ type: "response.completed", response: { id: "resp_explicit", output: [] } })
                  return
                }
                // The correction is admitted before response.created; its frame must wait for that event.
                yield* admit("Correction")
                expect(frames.filter((entry) => entry.type === "response.steer")).toHaveLength(0)
                yield* emit({ type: "response.created", response: { id: "resp_1" } })
                yield* emit({ type: "response.output_item.added", item })
                yield* emit({ type: "response.output_text.delta", item_id: item.id, delta: "Parent" })
                yield* emit({ type: "response.output_item.done", item })
                if (mode === "unsupported")
                  yield* emit({ type: "response.completed", response: { id: "resp_1", output: [item] } })
              }),
          }
        }),
    }
    const attemptWith = (webSocket: boolean) =>
      Effect.gen(function* () {
        const transport = yield* SessionModelTransport.Service
        const steps = yield* SessionStep.make
        const request = ai.request({
          model: model.model,
          messages: toLLMMessages(yield* history, model.ref, "openai"),
          tools: [{ name: "lookup", description: "Lookup", inputSchema: {} }],
        })
        return yield* steps.attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID: SessionMessage.ID.create(),
          agent: Agent.defaultID,
          model,
          prepared: {
            request,
            options: webSocket ? { webSocket: transport.bind(sessionID) } : {},
            retry: () => Effect.void,
            executeTool: () =>
              Effect.sync(() => {
                tools++
                return { content: [{ type: "text" as const, text: "Result" }] }
              }),
          },
          onSteer: () => { resets++ },
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
          retry: () => Effect.succeed({ retry: false as const }),
        })
      })
    return {
      connector,
      attempt: attemptWith(true),
      httpAttempt: attemptWith(false),
      frames,
      history,
      admit,
      sessionID,
      inbox,
      state: () => ({ opens, tools, persistedAtSend, resets }),
    }
  })

for (const mode of ["steered", "natural"] as const)
  it.effect(`accepted ${mode} parent consumes its automatic successor without another create`, () =>
    Effect.gen(function* () {
      const s = yield* setup(mode)
      yield* Effect.gen(function* () {
        expect((yield* s.attempt)._tag).toBe("Completed")
        expect(s.state().persistedAtSend).toBe(true)
        expect(s.state().resets).toBe(1)
        const parent = (yield* s.history).find((message) => message.type === "assistant")
        expect(parent).toBeDefined()
        expect(parent).not.toHaveProperty("tokens")
        expect(parent).not.toHaveProperty("cost")
        expect(s.frames[1]).toEqual({ type: "response.steer", previous_response_id: "resp_1", input: "Correction" })
        yield* s.attempt
        expect(s.frames.filter((frame) => frame.type === "response.create")).toHaveLength(1)
        expect(
          (yield* s.history).filter((message) => message.type === "user" && message.text === "Correction"),
        ).toHaveLength(1)
      }).pipe(Effect.provide(SessionModelTransport.makeLayer(s.connector)))
    }),
  )

it.effect("pending steering returns only required tool results on the parent connection", () =>
  Effect.gen(function* () {
    const s = yield* setup("pending")
    yield* Effect.gen(function* () {
      yield* s.attempt
      yield* s.attempt
      expect(s.state()).toMatchObject({ opens: 1, tools: 1, persistedAtSend: true })
      expect(s.frames.at(-1)).toMatchObject({ type: "response.create", previous_response_id: "resp_1" })
      expect(s.frames.at(-1)?.input).toEqual([{ type: "function_call_output", call_id: "call_1", output: "Result" }])
    }).pipe(Effect.provide(SessionModelTransport.makeLayer(s.connector)))
  }),
)

for (const code of ["steering_not_supported", "too_many_pending_steers", "response_not_found"] as const)
  it.effect(`${code} falls back once without resending a steer`, () =>
    Effect.gen(function* () {
      const id = code === "steering_not_supported" ? `gpt-6-unsupported-${Session.ID.create()}` : "gpt-6-sol"
      const s = yield* setup(code, id)
      yield* Effect.gen(function* () {
        yield* s.attempt
        yield* s.attempt
        expect(s.frames.filter((frame) => frame.type === "response.steer")).toHaveLength(1)
        expect(JSON.stringify(s.frames.at(-1)?.input).match(/Correction/g)).toHaveLength(1)
        expect(yield* s.inbox.list(s.sessionID)).toHaveLength(0)
      }).pipe(Effect.provide(SessionModelTransport.makeLayer(s.connector)))
      if (code === "steering_not_supported") {
        const suppressed = yield* setup("unsupported", id)
        yield* Effect.gen(function* () {
          yield* suppressed.attempt
          expect(suppressed.frames.filter((frame) => frame.type === "response.steer")).toHaveLength(0)
          expect(yield* suppressed.inbox.list(suppressed.sessionID)).toHaveLength(1)
        }).pipe(Effect.provide(SessionModelTransport.makeLayer(suppressed.connector)))
      }
    }),
  )

it.effect("accepted steering followed by 1006 remains in durable history without a recovery fence", () =>
  Effect.gen(function* () {
    const s = yield* setup("disconnect")
    yield* Effect.gen(function* () {
      yield* s.attempt.pipe(Effect.exit)
      expect(
        (yield* s.history).filter((message) => message.type === "user" && message.text === "Correction"),
      ).toHaveLength(1)
      expect(yield* s.inbox.list(s.sessionID)).toHaveLength(0)
      yield* s.attempt
      expect(s.state().opens).toBe(2)
      expect(s.frames.filter((frame) => frame.type === "response.steer")).toHaveLength(1)
      expect(s.frames.at(-1)).not.toHaveProperty("previous_response_id")
      expect(JSON.stringify(s.frames.at(-1)?.input).match(/Correction/g)).toHaveLength(1)
    }).pipe(Effect.provide(SessionModelTransport.makeLayer(s.connector)))
  }),
)

it.effect("a successor can itself receive a second steer", () =>
  Effect.gen(function* () {
    const s = yield* setup("successor")
    yield* Effect.gen(function* () {
      yield* s.attempt
      yield* s.admit("Second correction")
      yield* s.attempt
      expect(
        s.frames.filter((frame) => frame.type === "response.steer").map((frame) => frame.previous_response_id),
      ).toEqual(["resp_1", "resp_2"])
    }).pipe(Effect.provide(SessionModelTransport.makeLayer(s.connector)))
  }),
)

it.effect("GPT-5 uses ordinary boundary delivery, without client pre-emption", () =>
  Effect.gen(function* () {
    const s = yield* setup("unsupported", "gpt-5.6")
    yield* Effect.gen(function* () {
      expect((yield* s.attempt)._tag).toBe("Completed")
      expect(s.frames.map((frame) => frame.type)).toEqual(["response.create"])
      expect(yield* s.inbox.list(s.sessionID)).toHaveLength(1)
      expect(JSON.stringify(yield* s.history)).toContain("Parent")
    }).pipe(Effect.provide(SessionModelTransport.makeLayer(s.connector)))
  }),
)

it.effect("HTTP admission never pre-empts the response or sends a steering frame", () =>
  Effect.gen(function* () {
    const s = yield* setup("unsupported")
    const http = handlerLayer((input) =>
      Effect.gen(function* () {
        yield* s.admit("Correction")
        const item = {
          type: "message",
          id: "msg_http",
          role: "assistant",
          content: [{ type: "output_text", text: "Parent" }],
        }
        const events = [
          { type: "response.created", response: { id: "resp_http" } },
          { type: "response.output_item.added", item },
          { type: "response.output_text.delta", item_id: item.id, delta: "Parent" },
          { type: "response.output_item.done", item },
          { type: "response.completed", response: { id: "resp_http", output: [item] } },
        ]
        return input.respond(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })
      }),
    )
    yield* Effect.gen(function* () {
      expect((yield* s.httpAttempt)._tag).toBe("Completed")
      expect(s.frames).toHaveLength(0)
      expect(s.state().opens).toBe(0)
      expect(yield* s.inbox.list(s.sessionID)).toHaveLength(1)
      expect(JSON.stringify(yield* s.history)).toContain("Parent")
    }).pipe(
      Effect.provide(SessionModelTransport.makeLayer(s.connector)),
    Effect.provide(Layer.fresh(runtimeLayer(http))),
    )
  }),
)
