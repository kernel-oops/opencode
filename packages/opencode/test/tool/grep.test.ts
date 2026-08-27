import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "node:crypto"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
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
          }).complete,
        ).toBe(false)
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

  it.instance("keeps regex and include searches human-authorised", () =>
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
          identity: "grep",
          arguments: args,
          directory: test.directory,
          requested: captured.items[0]?.action,
        })
        expect(action.complete).toBe(false)
      }
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

  it.instance("fails closed when retained plugin arguments are mutated", () =>
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
      expect(resolved?.complete).toBe(false)
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

  it.instance("falls back to human authorisation for a hard-linked candidate", () =>
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
        identity: "grep",
        arguments: args,
        directory: test.directory,
        requested: captured.items[0]?.action,
      })
      expect(action.complete).toBe(false)
    }),
  )

  it.instance("keeps an explicit child directory outside the generic root contract", () =>
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
      expect(action.cwd).toBe(child)
      expect(snapshot.action.complete).toBe(false)
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
      ).toBe(false)
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
      const result = yield* grep.execute(
        {
          pattern: "line2",
          path: file,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(file)
      expect(result.output).toContain("Line 2: line2")
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
