/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { createRoot } from "solid-js"
import { createData } from "@opencode/client/solid"
import { OpenCode } from "@opencode/client/promise"
import { Host } from "@opencode/plugin/host"
import { ensurePluginRuntime, provides } from "@opencode/plugin/runtime"
import { Plugin, PluginContextProvider, usePlugin } from "@opencode/plugin/tui"

test("packed CLI export loads externally, shares prompt observation, and disposes/reloads without duplicate rows", async () => {
  ensurePluginRuntime()
  ensureRuntimePluginSupport({
    additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } },
    preserve: provides,
  })
  const directory = await mkdtemp(path.join(tmpdir(), "task-plugin-installed-"))
  const installed = path.join(directory, "node_modules/@kernel-oops/opencode-background-tasks")
  const consumer = path.join(directory, "consumer-source")
  await mkdir(installed, { recursive: true })
  const built = Bun.spawnSync([process.execPath, "run", "build", `--package-dir=${consumer}`], {
    cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  })
  if (built.exitCode !== 0) throw new Error(built.stderr.toString())
  const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", directory, "--quiet"], {
    cwd: consumer, stdout: "pipe", stderr: "pipe",
  })
  expect(packed.exitCode).toBe(0)
  const archive = (await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: directory })))[0]!
  expect(Bun.spawnSync(["tar", "-xf", path.join(directory, archive), "--strip-components=1", "-C", installed]).exitCode).toBe(0)
  const manifest = await Bun.file(path.join(installed, "package.json")).json()
  expect(manifest.dependencies).toBeUndefined()
  expect(manifest.devDependencies).toBeUndefined()
  expect(JSON.stringify(manifest)).not.toMatch(/workspace:|catalog:|\/mnt\/|\/home\//)
  expect(await Bun.file(path.join(installed, "LICENSE")).text()).toBe(await Bun.file(path.resolve(import.meta.dir, "../../../../LICENSE")).text())
  expect(await Bun.file(path.join(installed, "dist/session.d.ts")).text()).toContain("declare function sessionFamily")
  const helpers = await import(Bun.resolveSync("@kernel-oops/opencode-background-tasks/session", directory))
  expect(helpers.sessionFamily([{ id: "parent" }, { id: "child", parentID: "parent" }], "parent")).toEqual([{ session: { id: "child", parentID: "parent" }, prefix: "" }])
  const entry = Host.resolve({ directory, name: "@kernel-oops/opencode-background-tasks" }).tui
  expect(entry && fileURLToPath(entry).startsWith(installed)).toBe(true)
  expect(Host.resolve({ directory: installed }).tui).toBe(entry)
  const loaded = await Host.load(entry!) as { default: Plugin.Definition }
  const unsupported: unknown[] = []
  await loaded.default.setup({ data: { session: {} }, ui: { toast: { show: (value: unknown) => unsupported.push(value) }, slot: () => { throw new Error("Unsupported host registered a view") } } } as unknown as Plugin.Context)
  expect(unsupported).toHaveLength(1)
  await loaded.default.setup({ data: { session: { descendants: { sync() {} }, task: { observe() {} } } }, ui: { toast: { show: (value: unknown) => unsupported.push(value) }, slot: () => { throw new Error("Partial host registered a view") } } } as unknown as Plugin.Context)
  expect(unsupported).toHaveLength(2)
  let reads = 0
  const reply = Promise.withResolvers<Response>()
  const client = OpenCode.make({ baseUrl: "http://fixture.local", fetch: Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.endsWith("/task")) { reads++; return reply.promise }
    if (url.pathname === "/api/session/parent") return Response.json({
      id: "parent", projectID: "fixture", title: "Parent", location: { directory: "/project" },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    })
    return Response.json({ data: [], cursor: {} })
  }, { preconnect() {} }) })
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => client, directory: "/project", event: { on: () => () => {}, listen: () => () => {} } }), dispose,
  }))
  const claims = new Set<{ render: (input: { sessionID: string }) => unknown }>()
  const color = RGBA.fromInts(200, 200, 200)
  const context = {
    data: setup.data,
    theme: { text: { base: color, muted: color, feedback: { warning: { base: color }, error: { base: color }, success: { base: color } } } },
    ui: {
      slot(claim: { render: (input: { sessionID: string }) => unknown }) { claims.add(claim); return () => claims.delete(claim) },
      toast: { show() {} }, router: { navigate() {} },
    },
  } as unknown as Plugin.Context
  let cleanup = await loaded.default.setup(context)
  expect(claims.size).toBe(1)
  // This is the same data capability consumed by the built-in prompt controller.
  const stopPrompt = setup.data.session.task.observe("parent")
  const claim = [...claims][0]!
  const app = await testRender(() => <>{claim.render({ sessionID: "parent" }) as never}{claim.render({ sessionID: "parent" }) as never}</>, { width: 120, height: 20 })
  try {
    await app.renderOnce()
    expect(reads).toBe(1)
    const pending = setup.data.session.task.sync("parent")
    reply.resolve(Response.json({ paused: false, active: true, background: [{ sessionID: "child", agent: "Cat", description: "Packed fixture", status: "running" }] }))
    await pending
    await app.renderOnce()
    expect(app.captureCharFrame().match(/Packed fixture/g)).toHaveLength(2)
    if (typeof cleanup === "function") cleanup()
    expect(claims.size).toBe(0)
    cleanup = await loaded.default.setup(context)
    expect(claims.size).toBe(1)
    expect(reads).toBe(1)
  } finally {
    app.renderer.destroy()
    if (typeof cleanup === "function") cleanup()
    stopPrompt()
    expect(setup.data.session.task.get("parent")).toBeUndefined()
    setup.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test("unsupported stock-host capabilities produce one warning and no fallback polling or slot", async () => {
  const { default: plugin } = await import("../src/tui")
  const warnings: unknown[] = []
  let slots = 0
  await plugin.setup({ data: { session: {} }, ui: { toast: { show: (input: unknown) => warnings.push(input) }, slot: () => { slots++ } } } as unknown as Plugin.Context)
  expect(warnings).toHaveLength(1)
  expect(slots).toBe(0)
})
