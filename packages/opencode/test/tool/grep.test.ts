import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "node:crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { GrepTool } from "../../src/tool/grep"
import { provideInstance, testInstanceStoreLayer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { buildPermissionReviewSnapshot } from "../../src/permission/reviewer-input"
import { isGenericRiskAllowCandidate, resolveReviewAction } from "../../src/permission/generic-review-action"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"

type ReviewRequest = Omit<PermissionV1.Request, "id" | "sessionID" | "tool"> & {
  readonly action?: PermissionV1.ReviewAction
}

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  )

const it = testEffect(toolLayer())
const rooted = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

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

const root = path.join(__dirname, "../..")
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

async function openFileLinks() {
  return Promise.all(
    (await fs.readdir("/proc/self/fd")).map((fd) => fs.readlink(`/proc/self/fd/${fd}`).catch(() => "")),
  )
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

const git = Effect.fn("GrepToolTest.git")(function* (cwd: string, args: string[]) {
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

describe("tool.grep", () => {
  it.instance("allows an omitted-root literal content search", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "needle"))
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "needle" }

      yield* grep.execute(args, captured.next)

      expect(captured.items).toHaveLength(1)
      const request = captured.items[0]
      expect(request.metadata).toEqual({ pattern: "needle" })
      expect(Object.hasOwn(request.metadata, "path")).toBe(false)
      expect(Object.hasOwn(request.metadata, "include")).toBe(false)
      const action = resolveReviewAction({
        builtin: true,
        identity: "grep",
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
        trusted: [{ source: "human", text: "Find needle" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(snapshot.action.complete).toBe(true)
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "grep",
          assessment: {
            outcome: "allow",
            reason_code: "routine_or_low_impact",
            safer_alternative: "none",
          },
          snapshot,
        }),
      ).toBe(true)
    }),
  )

  it.instance("allows an explicit exact-root literal content search", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "needle"))
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "needle", path: test.directory }

      yield* grep.execute(args, captured.next)

      expect(captured.items[0]?.metadata).toEqual({ pattern: "needle", path: test.directory })
      const action = resolveReviewAction({
        builtin: true,
        identity: "grep",
        arguments: args,
        directory: test.directory,
        requested: captured.items[0]?.action,
      })
      const snapshot = buildPermissionReviewSnapshot({
        permission: "grep",
        origin: "tool",
        patterns: captured.items[0]?.patterns,
        metadata: captured.items[0]?.metadata,
        action,
        trusted: [{ source: "human", text: "Find needle" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(action.complete).toBe(true)
      expect(snapshot.action.complete).toBe(true)
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "grep",
          assessment: {
            outcome: "allow",
            reason_code: "routine_or_low_impact",
            safer_alternative: "none",
          },
          snapshot,
        }),
      ).toBe(true)
    }),
  )

  it.instance("allows the exact Calendar literal alternation against a pinned snapshot", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const pattern = "Calendar apps choose when to refresh|refreshes every 6 hours|PUBLISHED-TTL|REFRESH-INTERVAL"
      yield* Effect.promise(() =>
        Bun.write(
          path.join(test.directory, "Calendar.php"),
          "Calendar apps choose when to refresh\nPUBLISHED-TTL: PT6H\nnot a match\n",
        ),
      )
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern, path: test.directory }

      const result = yield* grep.execute(args, captured.next)
      const request = captured.items[0]
      if (!request) throw new Error("grep permission request was not captured")
      const action = resolveReviewAction({
        builtin: true,
        identity: "grep",
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
        trusted: [{ source: "human", text: "Check Calendar refresh behaviour" }],
        untrusted: [],
        contextSafeForGate: true,
      })

      expect(action.complete).toBe(true)
      expect(action.arguments).toMatchObject({
        pattern,
        path: test.directory,
        mode: "pinned-project-literal-grep-v4",
        executor: "literal-utf8-lf-lines-v1",
        bindingId: expect.stringMatching(/^[0-9a-f]{32}$/u),
        fileCount: 1,
        effects: [],
      })
      const actionArguments = request.action?.arguments
      if (typeof actionArguments !== "object" || actionArguments === null || Array.isArray(actionArguments))
        throw new Error("grep action arguments were not captured")
      for (const argumentsValue of [
        { ...actionArguments, executor: "unknown" },
        { ...actionArguments, bindingId: "not-an-id" },
        { ...actionArguments, mode: "pinned-project-literal-grep-v1" },
      ]) {
        expect(
          resolveReviewAction({
            builtin: true,
            identity: "grep",
            arguments: args,
            directory: test.directory,
            requested: { ...request.action!, arguments: argumentsValue },
          }),
        ).toEqual({
          identity: "grep",
          arguments: {
            contract: "registered-builtin-invocation-v1",
            effects_bound: false,
            invocation: args,
          },
          cwd: test.directory,
          complete: true,
        })
      }
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "grep",
          assessment: { outcome: "allow", reason_code: "routine_or_low_impact", safer_alternative: "none" },
          snapshot,
        }),
      ).toBe(true)
      expect(result.output).toContain("Calendar apps choose when to refresh")
      expect(result.output).toContain("PUBLISHED-TTL")
    }),
  )

  it.instance("uses unlinkable opaque binding IDs without serialising content commitments", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const content = "PUBLISHED-TTL: PT6H\n"
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "Opaque.php"), content))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "PUBLISHED-TTL", path: test.directory }
      const captures = [asks(), asks()]

      yield* grep.execute(args, captures[0].next)
      yield* grep.execute(args, captures[1].next)

      const snapshots = captures.map((capture) => {
        const request = capture.items[0]
        if (!request) throw new Error("grep permission request was not captured")
        return buildPermissionReviewSnapshot({
          permission: "grep",
          origin: "tool",
          patterns: request.patterns,
          metadata: request.metadata,
          action: resolveReviewAction({
            builtin: true,
            identity: "grep",
            arguments: args,
            directory: test.directory,
            requested: request.action,
          }),
          trusted: [{ source: "human", text: "Check Calendar refresh behaviour" }],
          untrusted: [],
          contextSafeForGate: true,
        })
      })
      const bindingIds = snapshots.map((snapshot) => {
        const argumentsValue = snapshot.action.arguments
        if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue))
          throw new Error("grep snapshot arguments were not captured")
        return Reflect.get(argumentsValue, "bindingId")
      })
      const serialised = JSON.stringify(snapshots)
      expect(bindingIds[0]).toMatch(/^[0-9a-f]{32}$/u)
      expect(bindingIds[1]).toMatch(/^[0-9a-f]{32}$/u)
      expect(bindingIds[0]).not.toBe(bindingIds[1])
      expect(serialised).not.toContain(createHash("sha256").update(content).digest("hex"))
      expect(serialised).not.toMatch(
        /contentDigest|generationDigest|directoryGenerationDigest|ctimeNs|mtimeNs|mountID/u,
      )
    }),
  )

  it.instance("uses bound project-search contracts for regex and include searches", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "needle"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      for (const args of [
        { pattern: "need.*", path: test.directory },
        { pattern: "needle", path: test.directory, include: "*.txt" },
      ]) {
        const captured = asks()
        yield* grep.execute(args, captured.next)
        const action = resolveReviewAction({
          builtin: true,
          permission: "grep",
          identity: "grep",
          arguments: args,
          directory: test.directory,
          requested: captured.items[0]?.action,
        })
        expect(action.complete).toBe(true)
        expect(action.arguments).toMatchObject({
          contract: "pinned-project-search-v1",
          mode: "directory",
          tool: "grep",
          executor: "ripgrep-procfd-cwd-v1",
          invocation: args,
          effects: [],
        })
      }
    }),
  )

  it.instance("keeps a production-shaped child Grep on its held directory across a symlink swap", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const templates = path.join(test.directory, "templates")
      const moved = path.join(test.directory, "templates-reviewed")
      const outside = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.mkdir(templates))
      yield* Effect.promise(() => Bun.write(path.join(templates, "flight.html"), "Import OCR duplicate\n"))
      yield* Effect.promise(() => Bun.write(path.join(outside, "secret.html"), "Import outside-secret\n"))
      const args = {
        pattern: "Import|Export|OCR|conflict|duplicate|remove|delete",
        path: templates,
        include: "*.{html,twig}",
      }
      let requested: PermissionV1.ReviewAction | undefined
      let replaced = false
      const next = {
        ...ctx,
        ask: (input: Parameters<Tool.Context["ask"]>[0]) =>
          Effect.promise(async () => {
            requested = input.action
            await fs.rename(templates, moved)
            await fs.symlink(outside, templates, "dir")
            replaced = true
          }),
      }
      const info = yield* GrepTool
      const grep = yield* info.init()

      const result = yield* grep.execute(args, next).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            if (!replaced) return
            await fs.rm(templates)
            await fs.rename(moved, templates)
          }),
        ),
      )

      expect(result.output).toContain("Import OCR duplicate")
      expect(result.output).not.toContain("outside-secret")
      expect(result.output).not.toContain("/proc/self/fd")
      const action = resolveReviewAction({
        builtin: true,
        permission: "grep",
        identity: "grep",
        arguments: args,
        directory: test.directory,
        requested,
      })
      expect(action.complete).toBe(true)
      expect(action.arguments).toMatchObject({ contract: "pinned-project-search-v1", tool: "grep" })
    }),
  )

  it.instance("fails closed before permission for a project Grep child symlink", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const real = path.join(test.directory, "templates-real")
      const linked = path.join(test.directory, "templates")
      yield* Effect.promise(() => fs.mkdir(real))
      yield* Effect.promise(() => fs.symlink(real, linked, "dir"))
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()

      const exit = yield* Effect.exit(grep.execute({ pattern: "Import.*OCR", path: linked }, captured.next))

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("could not be bound safely")
      expect(captured.items).toHaveLength(0)
    }),
  )

  it.instance("fails closed when the pinned root or candidate generation changes", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const outside = yield* tmpdirScoped()
      const moved = `${test.directory}.pinned-grep`
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "inside.txt"), "inside-marker\n"))
      yield* Effect.promise(() => Bun.write(path.join(outside, "outside.txt"), "outside-sentinel\n"))
      let replaced = false
      const next = {
        ...ctx,
        ask: () =>
          Effect.promise(async () => {
            await fs.rename(test.directory, moved)
            await fs.rename(path.join(moved, "inside.txt"), path.join(moved, "original.txt"))
            await Bun.write(path.join(moved, "inside.txt"), "outside-sentinel\n")
            await fs.symlink(outside, test.directory, "dir")
            replaced = true
          }),
      }
      const info = yield* GrepTool
      const grep = yield* info.init()

      const exit = yield* Effect.exit(
        grep.execute({ pattern: "marker|sentinel", path: test.directory }, next).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              if (!replaced) return
              await fs.rm(test.directory)
              await fs.rename(moved, test.directory)
            }),
          ),
        ),
      )

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("generation changed")
    }),
  )

  it.instance("closes snapshot descriptors on denial and cancellation", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "Calendar.php")
      yield* Effect.promise(() => Bun.write(filepath, "PUBLISHED-TTL\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const links = () =>
        fs
          .readdir("/proc/self/fd")
          .then((fds) => Promise.all(fds.map((fd) => fs.readlink(`/proc/self/fd/${fd}`).catch(() => ""))))
      const count = () => fs.readdir("/proc/self/fd").then((items) => items.length)

      yield* Effect.exit(
        grep.execute(
          { pattern: "PUBLISHED-TTL", path: test.directory },
          { ...ctx, ask: () => Effect.die(new Error("permission denied")) },
        ),
      )
      expect((yield* Effect.promise(links)).some((item) => item.includes("Calendar.php"))).toBe(false)

      const entered = yield* Deferred.make<void>()
      const baseline = yield* Effect.promise(count)
      const fiber = yield* grep
        .execute(
          { pattern: "PUBLISHED-TTL", path: test.directory },
          { ...ctx, ask: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      expect((yield* Effect.promise(links)).some((item) => item.includes("Calendar.php"))).toBe(false)
      // Other test fibres can open descriptors concurrently; the target-specific assertion above is exact.
      expect(yield* Effect.promise(count)).toBeLessThanOrEqual(baseline + 3)
    }),
  )

  it.instance("falls back to the exact lower-assurance invocation when retained plugin arguments are mutated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "Calendar.php"), "PUBLISHED-TTL\n"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "PUBLISHED-TTL", path: test.directory }
      let resolved: PermissionV1.ReviewAction | undefined
      const next = {
        ...ctx,
        ask: (request: ReviewRequest) =>
          Effect.sync(() => {
            args.pattern = "mutated"
            resolved = resolveReviewAction({
              builtin: true,
              identity: "grep",
              arguments: args,
              directory: test.directory,
              requested: request.action,
            })
          }),
      }

      const result = yield* grep.execute(args, next)
      expect(resolved).toEqual({
        identity: "grep",
        arguments: {
          contract: "registered-builtin-invocation-v1",
          effects_bound: false,
          invocation: args,
        },
        cwd: test.directory,
        complete: true,
      })
      expect(result.output).toContain("PUBLISHED-TTL")
    }),
  )

  it.instance("skips matching binary files without disclosing their contents", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(async () => {
        await Bun.write(path.join(test.directory, "binary.dat"), Buffer.from("PUBLISHED-TTL\0secret"))
        await Bun.write(path.join(test.directory, "text.txt"), "PUBLISHED-TTL visible\n")
      })
      const info = yield* GrepTool
      const grep = yield* info.init()

      const ripgrep = yield* Ripgrep.Service
      const expected = yield* ripgrep.grep({ cwd: test.directory, pattern: "PUBLISHED-TTL", limit: 100 })
      const result = yield* grep.execute({ pattern: "PUBLISHED-TTL", path: test.directory }, ctx)

      expect(result.metadata.matches).toBe(expected.length)
      expect(result.output).toContain("PUBLISHED-TTL visible")
      expect(result.output).not.toContain("secret")
    }),
  )

  it.instance("fails closed without returning partial output for invalid UTF-8", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(async () => {
        await Bun.write(path.join(test.directory, "first.txt"), "PUBLISHED-TTL visible\n")
        await Bun.write(path.join(test.directory, "invalid.txt"), Buffer.from([0x50, 0x55, 0x42, 0xff]))
      })
      const info = yield* GrepTool
      const grep = yield* info.init()

      const exit = yield* Effect.exit(grep.execute({ pattern: "PUBLISHED-TTL", path: test.directory }, ctx))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("Invalid byte sequence")
        expect(String(exit.cause)).not.toContain("visible")
      }
    }),
  )

  it.instance("matches ripgrep LF line numbering and text for accepted literals", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "lines.txt")
      yield* Effect.promise(() => Bun.write(filepath, "alpha LF\rbravo same line\ncharlie CRLF\r\ndelta final"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const ripgrep = yield* Ripgrep.Service
      const pattern = "alpha|bravo|charlie|delta"

      const expected = yield* ripgrep.grep({ cwd: test.directory, pattern, limit: 100 })
      const result = yield* grep.execute({ pattern, path: test.directory }, ctx)

      expect(result.metadata.matches).toBe(expected.length)
      expect(result.output).toBe(
        [
          `Found ${expected.length} matches`,
          `${filepath}:`,
          ...expected.map((row) => `  Line ${row.line}: ${row.text}`),
        ].join("\n"),
      )
      expect(expected.map((row) => row.line)).toEqual([1, 2, 3])
    }),
  )

  it.instance("matches ripgrep's deterministic 99, 100 and 101-result truncation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "many.txt")
      const info = yield* GrepTool
      const grep = yield* info.init()
      const ripgrep = yield* Ripgrep.Service
      for (const count of [99, 100, 101]) {
        yield* Effect.promise(() =>
          Bun.write(filepath, Array.from({ length: count }, (_, index) => `needle ${index}\n`).join("")),
        )
        const expected = yield* ripgrep.grep({ cwd: test.directory, pattern: "needle", limit: 100 })
        const result = yield* grep.execute({ pattern: "needle", path: test.directory }, ctx)
        expect(result.metadata.matches).toBe(expected.length)
        expect(result.metadata.matches).toBe(Math.min(count, 100))
        expect(result.metadata.truncated).toBe(count >= 100)
        expect(result.output.includes("more matches available")).toBe(count >= 100)
        expect(result.output).toBe(
          [
            `Found ${expected.length} matches${count >= 100 ? " (more matches available)" : ""}`,
            `${filepath}:`,
            ...expected.map((row) => `  Line ${row.line}: ${row.text}`),
            ...(count >= 100 ? ["", "(Results truncated. Consider using a more specific path or pattern.)"] : []),
          ].join("\n"),
        )
      }
    }),
  )

  it.instance("retains the exact pinned directory action for a hard-linked search candidate", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const test = yield* TestInstance
      const outside = yield* tmpdirScoped()
      const external = path.join(outside, "external.txt")
      yield* Effect.promise(async () => {
        await Bun.write(external, "PUBLISHED-TTL external\n")
        await fs.link(external, path.join(test.directory, "hardlink.txt"))
      })
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "PUBLISHED-TTL", path: test.directory }

      yield* grep.execute(args, captured.next)
      const action = resolveReviewAction({
        builtin: true,
        permission: "grep",
        identity: "grep",
        arguments: args,
        directory: test.directory,
        requested: captured.items[0]?.action,
      })
      expect(captured.items[0]?.action).toMatchObject({
        identity: "grep",
        arguments: { contract: "pinned-project-search-v1" },
        complete: true,
      })
      expect(action).toEqual(captured.items[0]?.action)
    }),
  )

  it.instance("retains an exact pinned child-directory action", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const child = path.join(test.directory, "child")
      yield* Effect.promise(() => fs.mkdir(child))
      yield* Effect.promise(() => Bun.write(path.join(child, "test.txt"), "needle"))
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "needle", path: child }

      yield* grep.execute(args, captured.next)

      const request = captured.items.at(-1)
      const action = resolveReviewAction({
        builtin: true,
        permission: "grep",
        identity: "grep",
        arguments: args,
        directory: test.directory,
        requested: request?.action,
      })
      const snapshot = buildPermissionReviewSnapshot({
        permission: "grep",
        origin: "tool",
        patterns: request?.patterns,
        metadata: request?.metadata,
        action,
        trusted: [{ source: "human", text: "Find needle" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(request?.action).toMatchObject({
        identity: "grep",
        arguments: { contract: "pinned-project-search-v1" },
        cwd: child,
        complete: true,
      })
      expect(action).toEqual(request?.action)
      expect(snapshot.action.cwd).toBe(child)
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "grep",
          directory: test.directory,
          assessment: {
            outcome: "allow",
            reason_code: "routine_or_low_impact",
            safer_alternative: "none",
          },
          snapshot,
        }),
      ).toBe(true)
    }),
  )

  rooted.live("basic search", () =>
    Effect.gen(function* () {
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* provideInstance(root)(
        grep.execute(
          {
            pattern: "export",
            path: path.join(root, "src/tool"),
            include: "*.ts",
          },
          ctx,
        ),
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
      expect(result.output).toContain("Found")
    }),
  )

  it.instance("no matches returns correct output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "hello world"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "xyznonexistentpatternxyz123",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
    }),
  )

  it.instance("finds matches in tmp instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
    }),
  )

  it.instance("does not report an unknown total when results are truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 101 }, (_, index) =>
            Bun.write(path.join(test.directory, `match-${index}.txt`), "needle"),
          ),
        ),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.txt" }, ctx)

      expect(result.output).toContain("(Results truncated. Consider using a more specific path or pattern.)")
      expect(result.output).not.toMatch(/showing \d+ of \d+ matches/)
    }),
  )

  it.instance("supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => Bun.write(file, "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "line2", path: file }
      const captured = asks()
      const result = yield* grep.execute(args, captured.next)
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).toContain("Line 2: line2")
      expect(
        resolveReviewAction({
          builtin: true,
          permission: "grep",
          identity: "grep",
          arguments: args,
          directory: test.directory,
          requested: captured.items.at(-1)?.action,
        }),
      ).toEqual({
        identity: "grep",
        arguments: {
          contract: "registered-builtin-invocation-v1",
          effects_bound: false,
          invocation: args,
        },
        cwd: test.directory,
        complete: true,
      })
    }),
  )

  it.instance("searches only the requested exact file and never an adjacent hidden sibling", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const requested = path.join(test.directory, "requested.txt")
      const hidden = path.join(test.directory, ".sibling-secret.txt")
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(requested, "needle requested-value"),
          Bun.write(hidden, "needle sibling-hidden-secret"),
        ]),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()

      const result = yield* grep.execute({ pattern: "needle", path: requested }, ctx)

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(requested)
      expect(result.output).toContain("requested-value")
      expect(result.output).not.toContain("sibling-hidden-secret")
      expect(result.output).not.toContain(hidden)
    }),
  )

  it.instance("binds an external exact file through both permissions and searches only that descriptor", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      const requested = path.join(outside, "requested.txt")
      const hidden = path.join(outside, ".sibling-secret.txt")
      yield* Effect.promise(() =>
        Promise.all([Bun.write(requested, "needle reviewed-value"), Bun.write(hidden, "needle sibling-hidden-secret")]),
      )
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()

      const result = yield* grep.execute({ pattern: "needle", path: requested }, captured.next)

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain("reviewed-value")
      expect(result.output).not.toContain("sibling-hidden-secret")
      expect(
        captured.items.find((item) => item.permission === "external_directory")?.metadata.searchBinding,
      ).toMatchObject({
        contract: "pinned-external-search-v1",
        mode: "file",
        executor: "ripgrep-inherited-readonly-fd-v1",
      })
      expect(captured.items.find((item) => item.permission === "grep")?.action?.arguments).toMatchObject({
        contract: "pinned-external-search-v1",
        kind: "file",
      })
      expect((yield* Effect.promise(openFileLinks)).some((item) => item.includes("requested.txt"))).toBe(false)
    }),
  )

  it.instance("treats a literal include in an external directory as one descriptor-bound file", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const test = yield* TestInstance
      const outside = yield* tmpdirScoped()
      const requested = path.join(outside, "requested.txt")
      const hidden = path.join(outside, "sibling-secret.txt")
      yield* Effect.promise(() =>
        Promise.all([Bun.write(requested, "needle reviewed-value"), Bun.write(hidden, "needle sibling-hidden-secret")]),
      )
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()
      const args = { pattern: "needle", path: outside, include: "requested.txt" }

      const result = yield* grep.execute(args, captured.next)

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(requested)
      expect(result.output).toContain("reviewed-value")
      expect(result.output).not.toContain("sibling-hidden-secret")
      const external = captured.items.find((item) => item.permission === "external_directory")
      expect(external?.metadata).toMatchObject({
        filepath: requested,
        parentDir: outside,
        searchBinding: {
          contract: "pinned-external-search-v1",
          mode: "file",
          executor: "ripgrep-inherited-readonly-fd-v1",
        },
      })
      expect(
        resolveReviewAction({
          builtin: true,
          permission: "external_directory",
          permissionMetadata: external?.metadata,
          identity: "grep",
          arguments: args,
          directory: test.directory,
        }).complete,
      ).toBe(true)
      const primary = captured.items.find((item) => item.permission === "grep")
      expect(
        resolveReviewAction({
          builtin: true,
          permission: "grep",
          permissionMetadata: primary?.metadata,
          identity: "grep",
          arguments: args,
          directory: test.directory,
          requested: primary?.action,
        }).complete,
      ).toBe(true)
      expect(primary?.action?.arguments).toMatchObject({
        contract: "pinned-external-search-v1",
        kind: "file",
        invocation: args,
      })
      expect((yield* Effect.promise(openFileLinks)).some((item) => item.includes("requested.txt"))).toBe(false)
    }),
  )

  it.instance("does not attest a literal external include that resolves through a file symlink", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      const target = path.join(outside, "target.txt")
      const linked = path.join(outside, "linked.txt")
      yield* Effect.promise(async () => {
        await Bun.write(target, "needle target-value")
        await fs.symlink(target, linked)
      })
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()

      yield* grep.execute({ pattern: "needle", path: outside, include: "linked.txt" }, captured.next)

      expect(captured.items.find((item) => item.permission === "external_directory")?.metadata).not.toHaveProperty(
        "searchBinding",
      )
      expect(captured.items.find((item) => item.permission === "grep")?.action?.complete).toBe(false)
      expect((yield* Effect.promise(openFileLinks)).some((item) => item.includes("target.txt"))).toBe(false)
    }),
  )

  it.instance("does not attest a literal external include through a user-controlled directory alias", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      const aliasRoot = yield* tmpdirScoped()
      const alias = path.join(aliasRoot, "linked-directory")
      yield* Effect.promise(async () => {
        await Bun.write(path.join(outside, "requested.txt"), "needle target-value")
        await fs.symlink(outside, alias)
      })
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()

      yield* grep.execute({ pattern: "needle", path: alias, include: "requested.txt" }, captured.next)

      expect(captured.items.find((item) => item.permission === "external_directory")?.metadata).not.toHaveProperty(
        "searchBinding",
      )
      expect(captured.items.find((item) => item.permission === "grep")?.action?.complete).toBe(false)
      expect((yield* Effect.promise(openFileLinks)).some((item) => item.includes("requested.txt"))).toBe(false)
    }),
  )

  it.instance("holds an external directory descriptor without attesting automatic completeness", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outside, "reviewed.txt"), "needle reviewed-value"))
      const captured = asks()
      const info = yield* GrepTool
      const grep = yield* info.init()

      const result = yield* grep.execute({ pattern: "needle", path: outside }, captured.next)

      expect(result.output).toContain("reviewed-value")
      expect(captured.items.find((item) => item.permission === "external_directory")?.metadata).not.toHaveProperty(
        "searchBinding",
      )
      expect(captured.items.find((item) => item.permission === "grep")?.action?.complete).toBe(false)
      expect((yield* Effect.promise(openFileLinks)).some((item) => item === outside)).toBe(false)
    }),
  )

  it.instance("aborts external directory Grep when its reviewed ancestor is replaced by a symlink", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      const reviewed = path.join(outside, "reviewed")
      const moved = path.join(outside, "reviewed-original")
      const replacement = path.join(outside, "replacement")
      yield* Effect.promise(async () => {
        await fs.mkdir(reviewed)
        await fs.mkdir(replacement)
        await Bun.write(path.join(reviewed, "value.txt"), "needle reviewed-value")
        await Bun.write(path.join(replacement, "secret.txt"), "needle replacement-secret")
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
      const info = yield* GrepTool
      const grep = yield* info.init()
      const exit = yield* Effect.exit(grep.execute({ pattern: "needle", path: reviewed }, next))

      expect(asks).toBe(2)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("External path changed")
    }),
  )

  it.instance("aborts external exact-file Grep when the reviewed file is replaced", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      const requested = path.join(outside, "reviewed.txt")
      const moved = path.join(outside, "reviewed-original.txt")
      yield* Effect.promise(() => Bun.write(requested, "needle reviewed-value"))
      let asks = 0
      const next: Tool.Context = {
        ...ctx,
        ask: () =>
          ++asks === 2
            ? Effect.promise(async () => {
                await fs.rename(requested, moved)
                await Bun.write(requested, "needle replacement-secret")
              })
            : Effect.void,
      }
      const info = yield* GrepTool
      const grep = yield* info.init()
      const exit = yield* Effect.exit(grep.execute({ pattern: "needle", path: requested }, next))

      expect(asks).toBe(2)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("External path changed")
    }),
  )

  it.instance("closes an external exact-file Grep descriptor on denial and cancellation", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      yield* TestInstance
      const outside = yield* tmpdirScoped()
      const requested = path.join(outside, "held.txt")
      yield* Effect.promise(() => Bun.write(requested, "needle held"))
      const info = yield* GrepTool
      const grep = yield* info.init()

      let deniedAsks = 0
      yield* Effect.exit(
        grep.execute(
          { pattern: "needle", path: requested },
          {
            ...ctx,
            ask: () => (++deniedAsks === 1 ? Effect.void : Effect.die(new Error("denied"))),
          },
        ),
      )
      expect(deniedAsks).toBe(2)
      expect((yield* Effect.promise(openFileLinks)).some((item) => item.includes("held.txt"))).toBe(false)

      const entered = yield* Deferred.make<void>()
      let cancelledAsks = 0
      const fiber = yield* grep
        .execute(
          { pattern: "needle", path: requested },
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
      expect((yield* Effect.promise(openFileLinks)).some((item) => item.includes("held.txt"))).toBe(false)
    }),
  )

  it.instance("checks external_directory against the resolved alias target", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* TestInstance
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-grep-alias-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const real = path.join(tmp, "real")
      const alias = path.join(tmp, "alias")
      yield* Effect.promise(() => fs.mkdir(real))
      yield* Effect.promise(() => fs.symlink(real, alias, "dir"))
      yield* Effect.promise(() => Bun.write(path.join(real, "test.txt"), "needle"))

      const ruleset = Permission.fromConfig({
        grep: "allow",
        external_directory: {
          [path.join(alias, "*")]: "allow",
        },
      })
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const next: Tool.Context = {
        ...ctx,
        ask: (req) =>
          Effect.sync(() => {
            const needsAsk = req.patterns.some(
              (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action !== "allow",
            )
            if (needsAsk) requests.push(req)
          }),
      }

      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: alias,
          include: "*.txt",
        },
        next,
      )

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(path.join(alias, "test.txt"))
      expect(result.output).not.toContain(path.join(real, "test.txt"))
      expect(requests.find((req) => req.permission === "external_directory")).toBeDefined()
    }),
  )
})
