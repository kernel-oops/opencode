import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
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

async function openFileLinks() {
  return Promise.all(
    (await fs.readdir("/proc/self/fd")).map((fd) => fs.readlink(`/proc/self/fd/${fd}`).catch(() => "")),
  )
}

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
  it.instance("uses a bound project-search contract for an omitted root path", () =>
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
        permission: "glob",
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
      expect(snapshot.action.complete).toBe(true)
      expect(snapshot.action.arguments).toMatchObject({
        contract: "pinned-project-search-v1",
        mode: "directory",
        tool: "glob",
        executor: "ripgrep-procfd-cwd-v1",
        invocation: args,
        effects: [],
      })
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
          directory: test.directory,
        }),
      ).toBe(true)

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

  it.instance("uses a bound project-search contract for an explicit exact-root path", () =>
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
        permission: "glob",
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
      expect(action.complete).toBe(true)
      expect(snapshot.action.complete).toBe(true)
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
          directory: test.directory,
        }),
      ).toBe(true)
    }),
  )

  it.instance("keeps an omitted-path search on the directory pinned before permission", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const outside = yield* tmpdirScoped()
      const moved = `${test.directory}.pinned-glob`
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "Flight-log.ts"), "inside\n"))
      yield* Effect.promise(() => Bun.write(path.join(outside, "Flight-log-secret.ts"), "outside\n"))
      let replaced = false
      let requested: PermissionV1.ReviewAction | undefined
      const next = {
        ...ctx,
        ask: (input: Parameters<Tool.Context["ask"]>[0]) =>
          Effect.promise(async () => {
            requested = input.action
            await fs.rename(test.directory, moved)
            await fs.symlink(outside, test.directory, "dir")
            replaced = true
          }),
      }
      const info = yield* GlobTool
      const glob = yield* info.init()

      const args = { pattern: "**/*{flight,Flight,log,Log}*" }
      const result = yield* glob.execute(args, next).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            if (!replaced) return
            await fs.rm(test.directory)
            await fs.rename(moved, test.directory)
          }),
        ),
      )

      expect(result.output).toContain(path.join(test.directory, "Flight-log.ts"))
      expect(result.output).not.toContain("Flight-log-secret")
      expect(result.output).not.toContain("/proc/self/fd")
      const action = resolveReviewAction({
        builtin: true,
        permission: "glob",
        identity: "glob",
        arguments: args,
        directory: test.directory,
        requested,
      })
      expect(action.complete).toBe(true)
      expect(action.arguments).toMatchObject({ contract: "pinned-project-search-v1", tool: "glob" })
    }),
  )

  it.instance("uses a bound project-search contract for an explicit child directory", () =>
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
        permission: "glob",
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
      expect(snapshot.action.complete).toBe(true)
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
          directory: test.directory,
        }),
      ).toBe(true)
    }),
  )

  it.instance("fails closed before permission for a project child symlink", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const real = path.join(test.directory, "real")
      const linked = path.join(test.directory, "linked")
      yield* Effect.promise(() => fs.mkdir(real))
      yield* Effect.promise(() => fs.symlink(real, linked, "dir"))
      const captured = asks()
      const info = yield* GlobTool
      const glob = yield* info.init()

      const exit = yield* Effect.exit(glob.execute({ pattern: "*.ts", path: linked }, captured.next))

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("could not be bound safely")
      expect(captured.items).toHaveLength(0)
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

  it.instance("holds an external directory descriptor without attesting automatic completeness", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outside, "reviewed.ts"), "reviewed"))
      const captured = asks()
      const info = yield* GlobTool
      const glob = yield* info.init()

      const result = yield* glob.execute({ pattern: "*.ts", path: outside }, captured.next)

      expect(result.output).toContain(path.join(outside, "reviewed.ts"))
      expect(captured.items.find((item) => item.permission === "external_directory")?.metadata).not.toHaveProperty(
        "searchBinding",
      )
      expect(captured.items.find((item) => item.permission === "glob")?.action?.complete).toBe(false)
      expect((yield* Effect.promise(openFileLinks)).some((item) => item === outside)).toBe(false)
    }),
  )

  it.instance("aborts external Glob when its reviewed directory is replaced by a symlink", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outer = yield* tmpdirScoped()
      const reviewed = path.join(outer, "reviewed")
      const moved = path.join(outer, "reviewed-original")
      const replacement = path.join(outer, "replacement")
      yield* Effect.promise(async () => {
        await fs.mkdir(reviewed)
        await fs.mkdir(replacement)
        await Bun.write(path.join(reviewed, "reviewed.ts"), "reviewed")
        await Bun.write(path.join(replacement, "secret.ts"), "replacement-secret")
      })
      let asks = 0
      const next: Tool.Context = {
        ...ctx,
        ask: () =>
          ++asks === 2
            ? Effect.promise(async () => {
                await fs.rename(reviewed, moved)
                await fs.symlink(replacement, reviewed, "dir")
              })
            : Effect.void,
      }
      const info = yield* GlobTool
      const glob = yield* info.init()
      const exit = yield* Effect.exit(glob.execute({ pattern: "*.ts", path: reviewed }, next))

      expect(asks).toBe(2)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("External path changed")
    }),
  )

  it.instance("closes an external Glob directory descriptor on denial and cancellation", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outer = yield* tmpdirScoped()
      const reviewed = path.join(outer, "held")
      yield* Effect.promise(() => fs.mkdir(reviewed))
      const info = yield* GlobTool
      const glob = yield* info.init()

      let deniedAsks = 0
      yield* Effect.exit(
        glob.execute(
          { pattern: "*.ts", path: reviewed },
          {
            ...ctx,
            ask: () => (++deniedAsks === 1 ? Effect.void : Effect.die(new Error("denied"))),
          },
        ),
      )
      expect(deniedAsks).toBe(2)
      expect((yield* Effect.promise(openFileLinks)).some((item) => item === reviewed)).toBe(false)

      const entered = yield* Deferred.make<void>()
      let cancelledAsks = 0
      const fiber = yield* glob
        .execute(
          { pattern: "*.ts", path: reviewed },
          {
            ...ctx,
            ask: () =>
              ++cancelledAsks === 1
                ? Effect.void
                : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          },
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      expect(cancelledAsks).toBe(2)
      expect((yield* Effect.promise(openFileLinks)).some((item) => item === reviewed)).toBe(false)
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
