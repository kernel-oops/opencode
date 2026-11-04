import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { Image } from "@opencode/core/image"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { AbsolutePath } from "@opencode/core/schema"
import { Tool } from "@opencode/core/tool"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ReadToolFileSystem } from "@opencode/core/tool/read-filesystem"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const linux = process.platform === "linux"
const readToolNode = makeLocationNode({
  name: "test/read-tool-plugin-bound",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Tool.node,
    ReadToolFileSystem.node,
    Environment.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    FSUtil.node,
    Location.node,
  ],
})
const sessionID = Session.ID.make("ses_read_bound_test")
const config = Config.testLayer()
const imageLayer = AppNodeBuilder.build(Image.node)

type Assert = (input: Permission.AssertInput) => Effect.Effect<void, Permission.Error>

const withRead = <A, E, R>(
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
      Layer.mergeAll(
        AppNodeBuilder.build(LayerNode.group([Tool.node, readToolNode]), [
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
          Config.node.replace(config),
          Image.node.replace(imageLayer),
          Global.node.replace(Global.layerWith({ data: Global.Path.data })),
        ]),
        config,
        imageLayer,
      ),
    ),
  )

const call = (input: unknown, id = "call-read") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "read", input },
})

const action = (input: Permission.AssertInput | undefined) =>
  input?.metadata?.action as { identity: string; arguments: any; cwd?: string; complete: boolean } | undefined

const fixtures = Effect.acquireRelease(
  Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
  (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
)

describe("bound read tool", () => {
  it.live("pins an external text file and serves the verified bytes", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      const file = path.join(outside.path, "notes.txt")
      yield* Effect.promise(() => fs.writeFile(file, "one\ntwo\nthree\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withRead(
        active.path,
        (registry) => executeTool(registry, call({ path: file, offset: 2, limit: 1 })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed" })
      if (result.status !== "completed") return
      expect(result.output).toMatchObject({ type: "text-page", content: "two", offset: 2, truncated: true, next: 3 })
      expect(result.content).toEqual([
        {
          type: "text",
          text: `Read file ${file}, lines 2-2\n2: two\n[Output truncated. Continue reading with offset: 3]`,
        },
      ])
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "read"])
      expect(assertions[0]).toMatchObject({ resources: [path.join(outside.path, "*")] })
      expect(assertions[0]?.metadata).toMatchObject({
        filepath: file,
        parentDir: outside.path,
        tool: "read",
        readScope: { version: 1, canonicalTarget: file, canonicalRoot: outside.path, kind: "file" },
        readBinding: { version: 1, contract: "pinned-external-text-v1" },
      })
      expect(assertions[1]).toMatchObject({ resources: [file], save: ["*"] })
      const read = action(assertions[1])
      expect(read).toMatchObject({ identity: "read", cwd: outside.path, complete: true })
      expect(read?.arguments).toMatchObject({
        contract: "pinned-external-text-v1",
        mode: "bound",
        invocation: { path: file, offset: 2, limit: 1 },
        effects: [],
      })
      expect(read?.arguments.bindingId).toBe((assertions[0]?.metadata as any).readBinding.bindingId)
      expect((assertions[1]?.metadata as any).readBinding.bindingId).toBe(read?.arguments.bindingId)
    }).pipe(Effect.scoped),
  )

  it.live("falls back to an ordinary reviewed read for an unbindable external file", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      const file = path.join(outside.path, "real.txt")
      yield* Effect.promise(() => fs.writeFile(file, "hello\n"))
      yield* Effect.promise(() => fs.symlink(file, path.join(outside.path, "link.txt")))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withRead(
        active.path,
        (registry) => executeTool(registry, call({ path: path.join(outside.path, "link.txt") })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed" })
      if (result.status !== "completed") return
      expect(result.output).toMatchObject({ type: "file", content: "hello\n" })
      expect(assertions.map((input) => input.action)).toEqual(["external_directory", "read"])
      expect((assertions[0]?.metadata as any).readBinding).toBeUndefined()
      expect(action(assertions[1])).toMatchObject({ identity: "read", complete: false })
      expect(action(assertions[1])?.arguments).toMatchObject({ path: path.join(outside.path, "link.txt") })
    }).pipe(Effect.scoped),
  )

  it.live("fails closed when a pinned external file changes after review", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active, outside] = yield* fixtures
      const file = path.join(outside.path, "notes.txt")
      yield* Effect.promise(() => fs.writeFile(file, "before\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withRead(
        active.path,
        (registry) => executeTool(registry, call({ path: file })),
        assertions,
        (input) => (input.action === "read" ? Effect.promise(() => fs.writeFile(file, "after\n")) : Effect.void),
      )
      expect(result.status).toBe("error")
      if (result.status !== "error") return
      expect(result.error?.message).toMatch(/changed/)
    }).pipe(Effect.scoped),
  )

  it.live("pins an exact project page read with no instruction files on its path", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active] = yield* fixtures
      const file = path.join(active.path, "src", "deep", "file.txt")
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(file, "a\nb\nc\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withRead(
        active.path,
        (registry) => executeTool(registry, call({ path: "src/deep/file.txt", offset: 1, limit: 2 })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed" })
      if (result.status !== "completed") return
      expect(result.output).toMatchObject({ type: "text-page", content: "a\nb", offset: 1, truncated: true })
      expect(assertions.map((input) => input.action)).toEqual(["read"])
      expect(assertions[0]).toMatchObject({ resources: ["src/deep/file.txt"], save: ["*"] })
      const read = action(assertions[0])
      expect(read).toMatchObject({ identity: "read", cwd: active.path, complete: true })
      expect(read?.arguments).toMatchObject({
        path: "src/deep/file.txt",
        offset: 1,
        limit: 2,
        target: path.join("src", "deep", "file.txt"),
        mode: "pinned-project-text-v4",
        instructionFilesAbsent: true,
        effects: [],
      })

      // An instruction file on the path removes the pinned route: the ordinary reviewed read applies.
      yield* Effect.promise(() => fs.writeFile(path.join(active.path, "src", "AGENTS.md"), "note"))
      assertions.length = 0
      const ordinary = yield* withRead(
        active.path,
        (registry) => executeTool(registry, call({ path: "src/deep/file.txt", offset: 1, limit: 2 }, "call-read-2")),
        assertions,
      )
      expect(ordinary).toMatchObject({ status: "completed" })
      expect(assertions.map((input) => input.action)).toEqual(["read"])
      expect(action(assertions[0])).toBeUndefined()
    }).pipe(Effect.scoped),
  )

  it.live("reads a whole project file through the ordinary path without a binding", () =>
    Effect.gen(function* () {
      if (!linux) return
      const [active] = yield* fixtures
      yield* Effect.promise(() => fs.writeFile(path.join(active.path, "README.md"), "hello\n"))
      const assertions: Permission.AssertInput[] = []
      const result = yield* withRead(
        active.path,
        (registry) => executeTool(registry, call({ path: "README.md" })),
        assertions,
      )
      expect(result).toMatchObject({ status: "completed", output: { type: "file", content: "hello\n" } })
      expect(assertions).toMatchObject([{ action: "read", resources: ["README.md"] }])
      expect(action(assertions[0])).toBeUndefined()
    }).pipe(Effect.scoped),
  )
})
