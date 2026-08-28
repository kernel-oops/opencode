import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, rename, symlink, writeFile } from "node:fs/promises"
import { Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect, verifyExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("no-ops for paths inside the instance directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, path.join(test.directory, "file.txt"))

      expect(requests.length).toBe(0)
    }),
  )

  it.instance("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside", "file.txt")
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { tool: "read" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
      expect(req!.metadata).toEqual({ filepath: target, parentDir: path.dirname(target), tool: "read" })
    }),
  )

  it.instance("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { requests, ctx } = makeCtx()

      const target = path.join(path.dirname(test.directory), "outside")
      const expected = glob(path.join(target, "*"))

      yield* assertExternalDirectoryEffect(ctx, target, { kind: "directory" })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
      expect(Object.hasOwn(req!.metadata, "tool")).toBe(false)
    }),
  )

  if (process.platform === "linux") {
    it.instance("emits exact canonical read-scope metadata only for an existing direct target", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const target = path.join(outside, "file.txt")
        yield* Effect.promise(() => writeFile(target, "content"))
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, target, { kind: "file", tool: "read" })

        const metadata = requests[0]?.metadata
        expect(metadata).toEqual({
          filepath: target,
          parentDir: outside,
          tool: "read",
          readScope: {
            version: 1,
            canonicalTarget: target,
            canonicalRoot: outside,
            kind: "file",
          },
        })
      }),
    )

    it.instance("canonicalises a symlink target but does not make it capability eligible", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const target = path.join(outside, "target.txt")
        const linked = path.join(outside, "linked.txt")
        yield* Effect.promise(async () => {
          await writeFile(target, "content")
          await symlink(target, linked)
        })
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, linked, { kind: "file", tool: "read" })

        expect(requests[0]?.metadata).toEqual({ filepath: target, parentDir: outside, tool: "read" })
      }),
    )

    it.instance("execution verifier rejects a target swapped after permission", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const target = path.join(outside, "flight.txt")
        const moved = path.join(outside, "original.txt")
        yield* Effect.promise(() => writeFile(target, "original"))
        const ctx: Tool.Context = {
          ...baseCtx,
          ask: () =>
            Effect.promise(async () => {
              await rename(target, moved)
              await writeFile(target, "replacement")
            }),
        }

        const verification = yield* assertExternalDirectoryEffect(ctx, target, { kind: "file", tool: "read" })
        const exit = yield* verifyExternalDirectoryEffect(verification).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )

    it.instance("execution verifier rejects an ancestor replaced by a symlink after permission", () =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        const root = path.join(outside, "approved")
        const moved = path.join(outside, "original")
        const replacement = path.join(outside, "replacement")
        const target = path.join(root, "flight.txt")
        yield* Effect.promise(async () => {
          await mkdir(root)
          await mkdir(replacement)
          await writeFile(target, "original")
          await writeFile(path.join(replacement, "flight.txt"), "replacement")
        })
        const ctx: Tool.Context = {
          ...baseCtx,
          ask: () =>
            Effect.promise(async () => {
              await rename(root, moved)
              await symlink(replacement, root)
            }),
        }

        const verification = yield* assertExternalDirectoryEffect(ctx, target, { kind: "file", tool: "read" })
        const exit = yield* verifyExternalDirectoryEffect(verification).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  }

  it.live("skips prompting when bypass=true", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

      expect(requests.length).toBe(0)
    }),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})
