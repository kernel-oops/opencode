import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { Permission } from "@opencode/core/permission"
import { Ripgrep } from "@opencode/core/ripgrep"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { GlobTool } from "@opencode/core/tool/plugin/glob"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { Tool } from "@opencode/core/tool"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const linux = process.platform === "linux"
const globToolNode = makeLocationNode({
  name: "test/glob-tool-plugin-bound",
  layer: Layer.effectDiscard(registerToolPlugin(GlobTool.Plugin)),
  deps: [Tool.node, Environment.node, Ripgrep.node, Location.node, FileAccess.node, Permission.node],
})
const grepToolNode = makeLocationNode({
  name: "test/grep-tool-plugin-bound",
  layer: Layer.effectDiscard(registerToolPlugin(GrepTool.Plugin)),
  deps: [Tool.node, Environment.node, Ripgrep.node, Location.node, FileAccess.node, Permission.node],
})
const sessionID = Session.ID.make("ses_search_bound_test")

type Assert = (input: Permission.AssertInput) => Effect.Effect<void, Permission.Error>

const withTools = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
  assertions: Permission.AssertInput[],
  assert: Assert = () => Effect.void,
) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, globToolNode, grepToolNode]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Permission.node.replace(
          permissionLayer({
            assert: (input) =>
              Effect.sync(() => {
                assertions.push(input)
              }).pipe(Effect.andThen(assert(input))),
          }),
        ),
      ]),
    ),
  )

const call = (name: "glob" | "grep", input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

const action = (input: Permission.AssertInput | undefined) =>
  input?.metadata?.action as { identity: string; arguments: any; cwd?: string; complete: boolean } | undefined

const fixtures = Effect.acquireRelease(
  Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
  (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
)

describe("bound search tools", () => {
  it.live("pins an external grep file behind a descriptor and attests the exact invocation", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      const file = path.join(outside.path, "outside.txt")
      yield* Effect.promise(() => fs.writeFile(file, "needle\nhay\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withTools(
        active.path,
        (registry) => executeTool(registry, call("grep", { path: file, pattern: "needle" })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed", metadata: { matches: 1, truncated: false } })
      if (result.status !== "completed") return
      expect(result.output).toEqual([expect.objectContaining({ line: 1, text: "needle\n" })])
      expect(result.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining(`${file}:`) })
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "grep"])
      expect(assertions[0]?.metadata).toMatchObject({
        filepath: file,
        parentDir: outside.path,
        tool: "grep",
        readScope: { version: 1, canonicalTarget: file, canonicalRoot: outside.path, kind: "file" },
        searchBinding: { version: 1, contract: "pinned-external-search-v1", mode: "file" },
      })
      const grep = action(assertions[1])
      expect(grep).toMatchObject({ identity: "grep", cwd: outside.path, complete: true })
      expect(grep?.arguments).toMatchObject({
        contract: "pinned-external-search-v1",
        mode: "bound",
        kind: "file",
        invocation: { path: file, pattern: "needle" },
        effects: [],
      })
      expect(grep?.arguments.bindingId).toBe((assertions[0]?.metadata as any).searchBinding.bindingId)
    }).pipe(Effect.scoped),
  )

  it.live("treats a plain include inside an external directory as an exact bound file search", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(path.join(outside.path, "notes.txt"), "needle\n"),
          fs.writeFile(path.join(outside.path, "other.txt"), "needle\n"),
        ]),
      )
      const assertions: Permission.AssertInput[] = []
      const result = yield* withTools(
        active.path,
        (registry) =>
          executeTool(registry, call("grep", { path: outside.path, pattern: "needle", include: "notes.txt" })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed", metadata: { matches: 1 } })
      expect(assertions[0]).toMatchObject({
        action: "external_directory",
        resources: [path.join(outside.path, "*")],
        metadata: { filepath: path.join(outside.path, "notes.txt"), tool: "grep" },
      })
      expect(action(assertions[1])).toMatchObject({ identity: "grep", complete: true })
      expect(action(assertions[1])?.arguments).toMatchObject({ contract: "pinned-external-search-v1", kind: "file" })
    }).pipe(Effect.scoped),
  )

  it.live("reviews an external directory grep without attesting completeness and confines it to one filesystem", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "outside.txt"), "needle\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withTools(
        active.path,
        (registry) => executeTool(registry, call("grep", { path: outside.path, pattern: "needle", include: "*.txt" })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed", metadata: { matches: 1 } })
      expect(assertions[0]?.metadata).toMatchObject({ filepath: outside.path, parentDir: outside.path, tool: "grep" })
      expect((assertions[0]?.metadata as any).searchBinding).toBeUndefined()
      expect(action(assertions[1])).toMatchObject({ identity: "grep", cwd: outside.path, complete: false })
      expect(action(assertions[1])?.arguments).toMatchObject({ pattern: "needle", include: "*.txt" })
    }).pipe(Effect.scoped),
  )

  it.live("pins project grep and glob searches behind the location descriptor", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active] = yield* fixtures
      yield* Effect.promise(() => fs.mkdir(path.join(active.path, "src")))
      yield* Effect.promise(() => fs.writeFile(path.join(active.path, "src", "a.ts"), "needle\n"))
      const assertions: Permission.AssertInput[] = []
      const results = yield* withTools(
        active.path,
        (registry) =>
          Effect.all([
            executeTool(registry, call("grep", { path: "src", pattern: "needle" })),
            executeTool(registry, call("glob", { pattern: "**/*.ts" })),
          ]),
        assertions,
      )
      expect(results[0]).toMatchObject({ status: "completed", metadata: { matches: 1 } })
      expect(results[0].output).toEqual([
        expect.objectContaining({ entry: { path: path.join("src", "a.ts"), type: "file" } }),
      ])
      expect(results[1]).toMatchObject({ status: "completed", metadata: { count: 1 } })
      expect(assertions.map((input) => input.action)).toEqual(["grep", "glob"])
      expect(action(assertions[0])).toMatchObject({
        identity: "grep",
        cwd: path.join(active.path, "src"),
        complete: true,
      })
      expect(action(assertions[0])?.arguments).toMatchObject({
        contract: "pinned-project-search-v1",
        mode: "directory",
        tool: "grep",
        executor: "ripgrep-procfd-cwd-v1",
        invocation: { path: "src", pattern: "needle" },
      })
      expect(action(assertions[1])).toMatchObject({ identity: "glob", cwd: active.path, complete: true })
      expect(action(assertions[1])?.arguments).toMatchObject({ contract: "pinned-project-search-v1", tool: "glob" })
    }).pipe(Effect.scoped),
  )

  it.live("reviews an external glob without a completeness claim", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      yield* Effect.promise(() => fs.writeFile(path.join(outside.path, "a.ts"), ""))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withTools(
        active.path,
        (registry) => executeTool(registry, call("glob", { path: outside.path, pattern: "*.ts" })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed", metadata: { count: 1 } })
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "glob"])
      expect(assertions[0]?.metadata).toMatchObject({ filepath: outside.path, tool: "glob" })
      expect(action(assertions[1])).toMatchObject({ identity: "glob", cwd: outside.path, complete: false })
    }).pipe(Effect.scoped),
  )

  it.live("asks about a non-existent external glob target before ever revealing that it is missing", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      const missing = path.join(outside.path, "does-not-exist")
      const assertions: Permission.AssertInput[] = []
      const result = yield* withTools(
        active.path,
        (registry) => executeTool(registry, call("glob", { path: missing, pattern: "*.ts" })),
        assertions,
        (input) =>
          Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources })),
      )
      // A declined `external_directory` ask, not a "does not exist" message: proves the ask fired, and
      // was rejected, strictly before the existence/type check that would otherwise reveal the target is
      // missing. Reordering the stat ahead of the ask (as a prior version of this file did) would instead
      // fail here with `Search path does not exist`, and `assertions` would stay empty.
      expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
      expect(result).toEqual({
        status: "error",
        error: { type: "permission.rejected", message: "Permission denied: external_directory" },
      })
    }).pipe(Effect.scoped),
  )

  it.live("fails closed when a pinned external file is replaced during review", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      const file = path.join(outside.path, "outside.txt")
      yield* Effect.promise(() => fs.writeFile(file, "needle\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withTools(
        active.path,
        (registry) => executeTool(registry, call("grep", { path: file, pattern: "needle" })),
        assertions,
        (input) =>
          input.action === "grep"
            ? Effect.promise(async () => {
                await fs.rename(file, path.join(outside.path, "old.txt"))
                await fs.writeFile(file, "needle\n")
              })
            : Effect.void,
      )
      expect(result.status).toBe("error")
      if (result.status !== "error") return
      expect(result.error?.message).toMatch(/changed/i)
    }).pipe(Effect.scoped),
  )

  it.live("fails closed when a pinned project search directory is swapped during review", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active] = yield* fixtures
      const src = path.join(active.path, "src")
      yield* Effect.promise(() => fs.mkdir(src))
      yield* Effect.promise(() => fs.writeFile(path.join(src, "a.ts"), "needle\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withTools(
        active.path,
        (registry) => executeTool(registry, call("grep", { path: "src", pattern: "needle" })),
        assertions,
        () =>
          Effect.promise(async () => {
            await fs.rename(src, path.join(active.path, "moved"))
            await fs.mkdir(src)
          }),
      )
      // The bound descriptor still refers to the reviewed directory; the search runs against it.
      expect(result).toMatchObject({ status: "completed", metadata: { matches: 1 } })
    }).pipe(Effect.scoped),
  )
})
