import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const policy = { target: 400_000, maximum: 480_000 }

it.live("Effect plugins set and remove context budgets through the public host", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    const created = yield* context.session.create({ title: "Plugin budget" })
    yield* context.session.update({ sessionID: created.id, contextBudget: policy })
    expect((yield* context.session.get({ sessionID: created.id })).contextBudget).toEqual(policy)
    yield* context.session.update({ sessionID: created.id, contextBudget: null })
    const removed = yield* context.session.get({ sessionID: created.id })
    expect(removed.contextBudget).toBeUndefined()
    expect(removed.contextBudgetState).toBeUndefined()
  }),
)

it.live("absent and undefined plugin budget fields preserve the policy and admission latch", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const context = yield* PluginHost.make(plugins)
    const created = yield* context.session.create({ title: "Unchanged plugin budget" })
    yield* sessions.setContextBudget({ sessionID: created.id, contextBudget: policy })
    const state = { attempted: { binding: "same-request", estimated: 410_000 } }
    yield* bus.publish(SessionEvent.ContextBudgetChanged, { sessionID: created.id, state })
    yield* context.session.update({ sessionID: created.id, title: "Renamed" })
    expect(yield* context.session.get({ sessionID: created.id })).toMatchObject({
      title: "Renamed",
      contextBudget: policy,
      contextBudgetState: state,
    })
    yield* context.session.update({ sessionID: created.id, contextBudget: undefined, metadata: { fixture: true } })
    expect(yield* context.session.get({ sessionID: created.id })).toMatchObject({
      metadata: { fixture: true },
      contextBudget: policy,
      contextBudgetState: state,
    })
    yield* context.session.update({ sessionID: created.id, contextBudget: policy })
    expect((yield* context.session.get({ sessionID: created.id })).contextBudgetState).toBeUndefined()
  }),
)

it.live("plugin budget updates reuse Core validation without changing the existing policy", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const context = yield* PluginHost.make(plugins)
    const created = yield* context.session.create({ title: "Invalid plugin budget" })
    yield* sessions.setContextBudget({ sessionID: created.id, contextBudget: policy })
    for (const invalid of [
      { target: 0, maximum: 480_000 },
      { target: 480_000, maximum: 400_000 },
      { target: 400_000.5, maximum: 480_000 },
      { target: 400_000, maximum: Infinity },
    ]) {
      const error = yield* context.session.update({ sessionID: created.id, contextBudget: invalid }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Session.InvalidContextBudgetError)
      expect((yield* context.session.get({ sessionID: created.id })).contextBudget).toEqual(policy)
    }
  }),
)

it.live("Promise plugins set, preserve and remove the same context budget", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const context = yield* PluginHost.make(plugins)
    const created = yield* context.session.create({ title: "Promise plugin budget" })
    yield* PluginPromise.fromPromise({
      id: "test.session-context-budget",
      async setup(ctx) {
        await ctx.session.update({ sessionID: created.id, contextBudget: policy })
        expect((await ctx.session.get({ sessionID: created.id })).contextBudget).toEqual(policy)
        await ctx.session.update({ sessionID: created.id, title: "Preserved", contextBudget: undefined })
        expect((await ctx.session.get({ sessionID: created.id })).contextBudget).toEqual(policy)
        await ctx.session.update({ sessionID: created.id, contextBudget: null })
        expect((await ctx.session.get({ sessionID: created.id })).contextBudget).toBeUndefined()
      },
    }).effect(context)
  }),
)
