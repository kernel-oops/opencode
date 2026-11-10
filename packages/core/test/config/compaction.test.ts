import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ConfigCompactionPlugin } from "@opencode/core/config/plugin/compaction"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Flag } from "@opencode/core/flag"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Session } from "@opencode/core/session"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { Document, Event, Info } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const model = LanguageModel.make({
  id: "test-model",
  provider: "test-provider",
  route: OpenAIChat.route,
})
const limit = { context: 100_000, output: 1_000 }
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit,
})
const config = Config.testLayer()
const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(
      LayerNode.group([SessionCompaction.node, SessionModelRequest.node, Config.node, Flag.node, Bus.node]),
      [
        llmClient.replace(
          Layer.mock(LLMClient.Service)({
            stream: () => Stream.make(LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summary" })),
          }),
        ),
        Config.node.replace(config),
        Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/tmp") })),
      ],
    ),
  ),
)
describe("ConfigCompactionPlugin.Plugin", () => {
  it.live("normalised global and named retention reaches the real consumer model lookup", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      const normalized = ConfigNormalize.normalize({ compaction: {
        keep: { tokens: 50_000, strict: true },
        models: {
          "anthropic/claude-haiku-5-5": { keep: { tokens: 15_000, strict: true } },
          "openai/gpt-6.1-sol": { keep: { tokens: 80_000, strict: false } },
        },
      } })
      if (normalized.type !== "normalized") throw new Error("Native retention document rejected")
      expect(normalized.diagnostics).toEqual([])
      yield* config.setEntries([new Document({ type: "document", info: Schema.decodeUnknownSync(Info)(normalized.encoded) })])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))
      const messages = ["oldest-marker", "middle-marker", "latest-marker"].map((text) => SessionMessage.User.make({
        id: SessionMessage.ID.create(), type: "user", text: text + "x".repeat(76_000), time: { created: DateTime.makeUnsafe(0) },
      }))
      const recent = (provider: string, id: string, history = messages) => Effect.gen(function* () {
        const selected = SessionRunnerModel.resolved(LanguageModel.make({ id, provider, route: OpenAIChat.route }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 1_000_000, output: 8192 },
        })
        const ended = yield* bus.subscribe(SessionEvent.Compaction.Ended).pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
        expect(yield* compaction.compact({ reason: "manual", context: { ...nearInput.context, model: selected, messages: history }, inputID: SessionMessage.ID.create() })).toEqual({ status: "completed" })
        return Option.getOrThrow(yield* Fiber.join(ended)).metadata?.keepID
      })
      for (const [provider, id, expected] of [
        ["anthropic", "claude-haiku-5-5", undefined],
        ["openai", "gpt-6.1-sol", messages[2].id],
        ["other", "no-override", messages[1].id],
      ] as const) {
        expect(yield* recent(provider, id)).toBe(expected)
      }
      const oversized = [messages[0], SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text: "latest-marker" + "x".repeat(400_000), time: { created: DateTime.makeUnsafe(0) } })]
      expect(yield* recent("openai", "gpt-6.1-sol", oversized)).toBe(oversized[1].id)
      expect(yield* recent("other", "no-override", oversized)).toBeUndefined()
    }),
  )

  it.live("exact model overrides merge nested keep fields and are removed on reload", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      const ref = "test-provider/test-model"
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              keep: new ConfigCompaction.Keep({ tokens: 50_000 }),
              models: { [ref]: new ConfigCompaction.Model({ keep: new ConfigCompaction.Keep({ tokens: 0 }) }) },
            }),
          }),
        }),
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              models: { [ref]: new ConfigCompaction.Model({ keep: new ConfigCompaction.Keep({ strict: true }) }) },
            }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))
      const messages = ["old", "latest"].map((text) =>
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text,
          time: { created: DateTime.makeUnsafe(0) },
        }),
      )
      const recent = () =>
        Effect.gen(function* () {
          const ended = yield* bus
            .subscribe(SessionEvent.Compaction.Ended)
            .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
          expect(
            yield* compaction.compact({
              reason: "manual",
              context: { ...nearInput.context, messages },
              inputID: SessionMessage.ID.create(),
            }),
          ).toEqual({ status: "completed" })
          return Option.getOrThrow(yield* Fiber.join(ended)).metadata?.keepID
        })
      expect(yield* recent()).toBeUndefined()
      yield* config.setEntries([])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((yield* recent()) === messages[1].id) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for model retention reload"))
    }),
  )

  it.live("merges settings and reloads changed config", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      // An automatic compaction that is not due is skipped.
      const due = (input: typeof nearInput) =>
        compaction
          .compact({ reason: "auto", context: input.context })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: false, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              buffer: 10_000,
              keep: new ConfigCompaction.Keep({ tokens: 0 }),
            }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      expect(yield* due(nearInput)).toBe(false)
      const ended = yield* bus
        .subscribe(SessionEvent.Compaction.Ended)
        .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      const messages = [
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Older context",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Recent context",
          time: { created: DateTime.makeUnsafe(1) },
        }),
      ]
      expect(
        yield* compaction.compact({
          reason: "manual",
          context: { ...nearInput.context, messages },
          inputID: SessionMessage.ID.make("msg_compaction_manual"),
        }),
      ).toEqual({ status: "completed" })
      expect(Option.getOrThrow(yield* Fiber.join(ended)).metadata?.keepID).toBe(messages[1].id)

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ buffer: 10_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (yield* due(nearInput)) return
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
      })
      expect(yield* due(bufferedInput)).toBe(false)

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* due(bufferedInput)) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
    }),
  )
})

const session = Session.Info.make({
  id: Session.ID.make("ses_compaction_config"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})
const input = (tokens: number) => {
  const messages = [
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.make("msg_compaction_config"),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "test-model", providerID: "test-provider" },
      content: [],
      tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    }),
  ]
  return {
    session,
    resolved,
    messages,
    context: {
      session,
      model: resolved,
      messages,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      initial: [],
      tools: { definitions: [], execute: () => Effect.die("unused") },
    },
  }
}
const bufferedInput = input(85_000)
const nearInput = input(95_000)
