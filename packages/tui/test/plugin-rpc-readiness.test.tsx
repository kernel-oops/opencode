import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, symlink } from "node:fs/promises"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

// A combined plugin whose TUI setup gates on its server half's RPC, as KCP's DCP panel does. Since #62796 the
// server answers RPCs without waiting for plugin activation, so a cold or reloading server rejects the first call.
const source = `
  import { Plugin } from "@opencode/plugin/tui"
  import { Schema } from "effect"
  const rpc = {
    id: "dcp",
    methods: {
      status: {
        input: Schema.toStandardSchemaV1(Schema.Struct({})),
        output: Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean })),
      },
    },
  }
  export default Plugin.define({ id: "fixture.readiness", async setup(ctx) {
    const client = ctx.client.rpc(rpc)
    const options = () => ({ location: ctx.location ?? ctx.data.location.default() })
    if (!(await client.status({}, options())).enabled) return
    ctx.ui.slot({ append: "app", render: () => <text>RPC READY</text> })
  } })
`

const rpcError = (type: string) =>
  Response.json({ _tag: "RpcError", type, message: `RPC is unavailable: dcp (${type})` }, { status: 400 })

async function start(input: { listed: () => boolean; answer: () => Response }) {
  const root = await tmpdir()
  const plugin = path.join(root.path, "readiness")
  await mkdir(plugin)
  await symlink(path.join(import.meta.dir, "../node_modules"), path.join(plugin, "node_modules"))
  await Bun.write(path.join(plugin, "tui.tsx"), source)
  const counts = { status: 0, list: 0 }
  const setup = await createAppFixture({
    config: { animations: false, plugins: [plugin] },
    fetch: (url) => {
      if (url.pathname.startsWith("/api/rpc/")) {
        counts.status++
        return input.answer()
      }
      if (url.pathname === "/api/plugin") {
        counts.list++
        return Response.json({
          location: { directory: "/fixture" },
          data: input.listed()
            ? [
                {
                  id: "fixture.readiness",
                  source: { type: "local", path: plugin },
                  features: { server: true, tui: true },
                  state: { status: "active" },
                },
              ]
            : [],
        })
      }
      return undefined
    },
  })
  let event = 0
  // Publishes plugin.updated and waits until the TUI has refetched the inventory and settled.
  const updated = async () => {
    const lists = counts.list
    setup.events.emit({ id: `evt_${++event}`, created: event, type: "plugin.updated", data: {} })
    await setup.waitFor(() => counts.list > lists)
    await setup.flush()
  }
  return {
    counts,
    setup,
    updated,
    async [Symbol.asyncDispose]() {
      await setup[Symbol.asyncDispose]()
      await root[Symbol.asyncDispose]()
    },
  }
}

test("cold start: a setup rejected before the server half registers its RPC retries once that plugin is active", async () => {
  let active = false
  await using app = await start({
    listed: () => active,
    answer: () => (active ? Response.json({ output: { enabled: true } }) : rpcError("rpc.unavailable")),
  })
  await app.setup.ready
  await app.setup.waitFor(() => app.counts.status === 1)
  await app.setup.waitForFrame((frame) => frame.includes("1 plugin failed"))
  // An inventory refresh that does not list the plugin active is no reason to retry.
  await app.updated()
  expect(app.counts.status).toBe(1)

  active = true
  await app.updated()
  await app.setup.waitForFrame((frame) => frame.includes("RPC READY"))
  expect(app.counts.status).toBe(2)
  expect(app.setup.captureCharFrame()).not.toContain("plugin failed")

  // Once set up, later server updates leave the plugin alone.
  await app.updated()
  expect(app.counts.status).toBe(2)
})

test("server reload: an unchanged active inventory after the reload still retries the rejected setup", async () => {
  // The inventory lists the plugin active throughout while its RPC is gone, as when a location reloads under the TUI.
  let registered = false
  await using app = await start({
    listed: () => true,
    answer: () => (registered ? Response.json({ output: { enabled: true } }) : rpcError("rpc.unavailable")),
  })
  await app.setup.ready
  await app.setup.waitForFrame((frame) => frame.includes("1 plugin failed"))
  await app.setup.flush()
  const rejected = app.counts.status
  // Bounded: the first setup plus at most one retry per inventory read, never a polling loop.
  expect(rejected).toBeLessThanOrEqual(app.counts.list + 1)
  await Bun.sleep(300)
  expect(app.counts.status).toBe(rejected)

  registered = true
  await app.updated()
  await app.setup.waitForFrame((frame) => frame.includes("RPC READY"))
  expect(app.counts.status).toBe(rejected + 1)
  await app.updated()
  expect(app.counts.status).toBe(rejected + 1)
})

test("a genuine setup failure is not retried when the server plugin is active", async () => {
  await using app = await start({ listed: () => true, answer: () => rpcError("rpc.invalid_input") })
  await app.setup.ready
  await app.setup.waitForFrame((frame) => frame.includes("1 plugin failed"))
  await app.setup.flush()
  const failed = app.counts.status
  await app.updated()
  await app.updated()
  expect(app.counts.status).toBe(failed)
  expect(app.setup.captureCharFrame()).toContain("1 plugin failed")
  expect(app.setup.captureCharFrame()).not.toContain("RPC READY")
})
