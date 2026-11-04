import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import path from "node:path"
import { Global } from "@opencode/util/global"
import type { TuiInput } from "../../src/app"
import type { Config } from "../../src/config"
import { tmpdir } from "./fixture"
import { createEventStream, createFetch, type FetchHandler } from "./tui-client"

// Every Global path lives under root (state is root itself unless given): a default would resolve to the
// developer's real XDG directories, and the app discovers plugins from Global.config.
export function isolatedGlobal(root: string, state = root) {
  return Global.layerWith({
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    state,
    bin: path.join(root, "cache", "bin"),
    log: path.join(root, "data", "log"),
    repos: path.join(root, "data", "repos"),
    tmp: path.join(root, "tmp"),
  })
}

export async function createAppFixture(
  input: {
    width?: number
    height?: number
    state?: string
    config?: Config.Info
    args?: TuiInput["args"]
    fetch?: FetchHandler
    // A renderer whose owner already set up its terminal, such as the simulation renderer.
    setup?: TestRendererSetup
  } = {},
) {
  const { run } = await import("../../src/app")
  const root = await tmpdir()
  const setup =
    input.setup ??
    (await createTestRenderer({
      width: input.width ?? 100,
      height: input.height ?? 30,
      kittyKeyboard: true,
    }))
  if (!input.setup) await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const calls = createFetch(input.fetch, events)
  // Updates apply to a copy, as a config file would, so preference writes persist for the rest of the test.
  let config: Config.Info = structuredClone(input.config ?? { animations: false })
  const server = Bun.serve({ port: 0, fetch: (request) => calls.serve(request) })
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => config,
        update: async (mutate) => {
          const next = structuredClone(config)
          mutate(next)
          config = next
          return next
        },
      },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: input.args ?? {},
      log: () => {},
    }).pipe(
      Effect.provide(isolatedGlobal(root.path, input.state ?? path.join(root.path, "state"))),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    ...setup,
    events,
    config: () => config,
    ready: ready.promise,
    async [Symbol.asyncDispose]() {
      try {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy()
        await task
      } finally {
        await server.stop()
        await root[Symbol.asyncDispose]()
      }
    },
  }
}
