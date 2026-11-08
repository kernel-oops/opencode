import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Session } from "@opencode/core/session"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

const it = testEffect(makePluginTestLayer())

it.effect("assistant synthetic inherits identity, strips controls and admits no model work", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const ctx = yield* PluginHost.make(plugins, "test")
    const sessions = yield* Session.Service
    const session = yield* ctx.session.create({ agent: Agent.ID.make("test"), model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") }) })
    const before = yield* sessions.get(session.id)
    const unfinished = yield* ctx.session.synthetic({ sessionID: session.id, role: "assistant", text: "Never open", final: false }).pipe(Effect.exit)
    expect(unfinished._tag).toBe("Failure")
    expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
    const note = yield* ctx.session.synthetic({
      sessionID: session.id, role: "assistant", text: "Derived maintenance record, not approval",
      metadata: { derived: true, controllerState: "maintenance", experimental: { checkpoint: true }, keepID: "forged", native: {} },
    })
    const messages = yield* sessions.messages({ sessionID: session.id })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: note.id, type: "assistant", agent: before.agent, model: before.model,
      content: [{ type: "text", text: "Derived maintenance record, not approval" }],
      metadata: { derived: true, controllerState: "maintenance" },
      finish: "stop", cost: 0,
    })
    expect(messages[0]?.metadata).toEqual({ derived: true, controllerState: "maintenance" })
    expect(yield* sessions.inbox(session.id)).toEqual([])
    expect((yield* sessions.active).has(session.id)).toBe(false)
    expect((yield* sessions.get(session.id)).tokens).toEqual(before.tokens)
    // The original synthetic-input route still admits work without starting a turn when requested.
    const input = yield* ctx.session.synthetic({ sessionID: session.id, text: "Original input", resume: false })
    expect(input.type).toBe("synthetic")
    expect(yield* sessions.inbox(session.id)).toHaveLength(1)
  }),
)

it.effect("Promise assistant synthetic bypasses inbox encoding and retains ordinary input compatibility", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const ctx = yield* PluginHost.make(plugins, "test")
    const sessions = yield* Session.Service
    const session = yield* ctx.session.create({ agent: Agent.ID.make("test"), model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") }) })
    yield* PluginPromise.fromPromise({
      id: "assistant-synthetic-test",
      async setup(context) {
        const note = await context.session.synthetic({ sessionID: session.id, role: "assistant", text: "Promise note", final: true })
        expect(note.id).toMatch(/^msg_/)
        const input = await context.session.synthetic({ sessionID: session.id, text: "Original input", resume: false })
        expect(input.type).toBe("synthetic")
      },
    }).effect(ctx)
    expect(yield* sessions.messages({ sessionID: session.id })).toMatchObject([{ type: "assistant", content: [{ type: "text", text: "Promise note" }] }])
    expect(yield* sessions.inbox(session.id)).toHaveLength(1)
    expect((yield* sessions.active).has(session.id)).toBe(false)
  }),
)
