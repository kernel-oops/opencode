import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { buildPermissionReviewSnapshot } from "../../src/permission/reviewer-input"
import { isGenericRiskAllowCandidate, resolveReviewAction } from "../../src/permission/generic-review-action"

type ReviewRequest = Omit<PermissionV1.Request, "id" | "sessionID" | "tool"> & {
  readonly action?: PermissionV1.ReviewAction
}

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  )

const it = testEffect(toolLayer())
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const asks = () => {
  const items: ReviewRequest[] = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

const git = Effect.fn("GlobToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})

describe("tool.glob", () => {
  it.instance("keeps an omitted path human-authorised because descendant mounts are not pinned", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      const captured = asks()
      const info = yield* GlobTool
      const glob = yield* info.init()
      const args = { pattern: "*.ts" }

      yield* glob.execute(args, captured.next)

      expect(captured.items).toHaveLength(1)
      const request = captured.items[0]
      expect(request.metadata).toEqual({ pattern: "*.ts" })
      expect(Object.hasOwn(request.metadata, "path")).toBe(false)
      const action = resolveReviewAction({
        builtin: true,
        identity: "glob",
        arguments: args,
        directory: test.directory,
        requested: request.action,
      })
      const snapshot = buildPermissionReviewSnapshot({
        permission: request.permission,
        origin: "tool",
        patterns: request.patterns,
        metadata: request.metadata,
        action,
        trusted: [{ source: "human", text: "Find TypeScript files" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(snapshot.action.complete).toBe(false)
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "glob",
          assessment: {
            outcome: "allow",
            reason_code: "routine_or_low_impact",
            safer_alternative: "none",
          },
          snapshot,
        }),
      ).toBe(false)

      const pending = [
        {
          ...request,
          id: PermissionV1.ID.make("per_glob_json"),
          sessionID: ctx.sessionID,
          tool: { messageID: ctx.messageID, callID: "call_glob_json" },
        },
      ]
      const encoded = Schema.encodeUnknownSync(Schema.Array(PermissionV1.Request))(pending)
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
    }),
  )

  it.instance("keeps an explicit exact-root path human-authorised", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const captured = asks()
      const info = yield* GlobTool
      const glob = yield* info.init()
      const args = { pattern: "*.ts", path: test.directory }

      yield* glob.execute(args, captured.next)

      expect(captured.items[0]?.metadata).toEqual({ pattern: "*.ts", path: test.directory })
      const action = resolveReviewAction({
        builtin: true,
        identity: "glob",
        arguments: args,
        directory: test.directory,
        requested: captured.items[0]?.action,
      })
      const snapshot = buildPermissionReviewSnapshot({
        permission: "glob",
        origin: "tool",
        patterns: captured.items[0]?.patterns,
        metadata: captured.items[0]?.metadata,
        action,
        trusted: [{ source: "human", text: "Find TypeScript files" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(action.complete).toBe(false)
      expect(snapshot.action.complete).toBe(false)
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "glob",
          assessment: {
            outcome: "allow",
            reason_code: "routine_or_low_impact",
            safer_alternative: "none",
          },
          snapshot,
        }),
      ).toBe(false)
    }),
  )

  it.instance("keeps an omitted-path search on the directory pinned before permission", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const outside = yield* tmpdirScoped()
      const moved = `${test.directory}.pinned-glob`
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "inside-marker.ts"), "inside\n"))
      yield* Effect.promise(() => Bun.write(path.join(outside, "outside-sentinel.ts"), "outside\n"))
      let replaced = false
      const next = {
        ...ctx,
        ask: () =>
          Effect.promise(async () => {
            await fs.rename(test.directory, moved)
            await fs.symlink(outside, test.directory, "dir")
            replaced = true
          }),
      }
      const info = yield* GlobTool
      const glob = yield* info.init()

      const result = yield* glob.execute({ pattern: "*.ts" }, next).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            if (!replaced) return
            await fs.rm(test.directory)
            await fs.rename(moved, test.directory)
          }),
        ),
      )

      expect(result.output).toContain(path.join(test.directory, "inside-marker.ts"))
      expect(result.output).not.toContain("outside-sentinel")
      expect(result.output).not.toContain("/proc/self/fd")
    }),
  )

  it.instance("keeps an explicit child directory outside the generic root contract", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const child = path.join(test.directory, "child")
      yield* Effect.promise(() => fs.mkdir(child))
      const captured = asks()
      const info = yield* GlobTool
      const glob = yield* info.init()
      const args = { pattern: "*.ts", path: child }

      yield* glob.execute(args, captured.next)

      const request = captured.items.at(-1)
      const action = resolveReviewAction({
        builtin: true,
        identity: "glob",
        arguments: args,
        directory: test.directory,
        requested: request?.action,
      })
      const snapshot = buildPermissionReviewSnapshot({
        permission: "glob",
        origin: "tool",
        patterns: request?.patterns,
        metadata: request?.metadata,
        action,
        trusted: [{ source: "human", text: "Find TypeScript files" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(action.cwd).toBe(child)
      expect(snapshot.action.complete).toBe(false)
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "glob",
          assessment: {
            outcome: "allow",
            reason_code: "routine_or_low_impact",
            safer_alternative: "none",
          },
          snapshot,
        }),
      ).toBe(false)
    }),
  )

  it.instance("matches files from a directory path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute(
        {
          pattern: "*.ts",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("rejects exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "export const a = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const exit = yield* glob
        .execute(
          {
            pattern: "*.ts",
            path: file,
          },
          ctx,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain("glob path must be a directory")
      }
    }),
  )
})
