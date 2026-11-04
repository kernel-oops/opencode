import { expect } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Permission } from "@opencode/core/permission"
import { Agent } from "@opencode/core/agent"
import { testEffect } from "./lib/effect"
import { makePluginTestLayer } from "./plugin/fixture"

const it = testEffect(makePluginTestLayer(undefined, undefined, true))

for (const scope of [undefined, "request"] as const) {
  it.effect(`plugin rejection preserves the requested scope (${scope ?? "session"})`, () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const ctx = yield* PluginHost.make(plugins)
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => editor.update(Agent.ID.make("test"), (agent) => { agent.permissions = [] }))
      const session = yield* ctx.session.create({ agent: Agent.ID.make("test"), permissions: [{ action: "*", resource: "*", effect: "ask" }] })
      const permission = yield* Permission.Service
      yield* permission.ask({ sessionID: session.id, action: "read", resources: ["first"] })
      yield* permission.ask({ sessionID: session.id, action: "read", resources: ["second"] })
      const requests = yield* ctx.permission.list({ sessionID: session.id })
      expect(requests).toHaveLength(2)
      yield* ctx.permission.reply({ sessionID: session.id, requestID: requests[0]!.id, decision: "reject", experimental: { scope } })
      expect(yield* ctx.permission.list({ sessionID: session.id })).toHaveLength(scope === "request" ? 1 : 0)
    }),
  )
}
