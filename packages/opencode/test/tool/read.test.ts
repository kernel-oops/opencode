import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import path from "path"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import {
  bindProjectTextFile,
  closeBoundProjectTextFile,
  readBoundProjectTextFile,
  supportsInstructionWatchFilesystem,
} from "../../src/tool/read-bound-file"
import { generation } from "../../src/tool/bound-generation"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import { buildPermissionReviewSnapshot } from "../../src/permission/reviewer-input"
import { isGenericRiskAllowCandidate, resolveReviewAction } from "../../src/permission/generic-review-action"

type ReviewRequest = Omit<PermissionV1.Request, "id" | "sessionID" | "tool"> & {
  readonly action?: PermissionV1.ReviewAction
}
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

afterEach(async () => {
  await disposeAllInstances()
})

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

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
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
const git = Effect.fn("ReadToolTest.git")(function* (cwd: string, args: string[]) {
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
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})
async function inotifyWatchCount() {
  let count = 0
  for (const fd of await fs.readdir("/proc/self/fd")) {
    const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8").catch(() => "")
    count += info.match(/^inotify wd:/gmu)?.length ?? 0
  }
  return count
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
    },
  }
}

describe("tool.read pinned project text review", () => {
  it.live("fails instruction watching closed on an unsupported filesystem", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const supported = yield* Effect.acquireRelease(
        Effect.promise(() => fs.open(dir, "r")),
        (file) => Effect.promise(() => file.close()),
      )
      const unsupported = yield* Effect.acquireRelease(
        Effect.promise(() => fs.open("/proc", "r")),
        (file) => Effect.promise(() => file.close()),
      )
      expect(yield* Effect.promise(() => supportsInstructionWatchFilesystem(supported.fd))).toBe(true)
      expect(yield* Effect.promise(() => supportsInstructionWatchFilesystem(unsupported.fd))).toBe(false)
    }),
  )

  it.live("closes a directory descriptor when watcher creation fails synchronously", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "WatcherFailure.php")
      yield* put(filepath, "<?php\n// watcher failure\n")

      const bound = yield* Effect.promise(() =>
        bindProjectTextFile(dir, filepath, {
          createWatcher: () => {
            throw new Error("simulated synchronous watcher creation failure")
          },
        }),
      )

      expect(bound).toBeUndefined()
      const links = yield* Effect.promise(async () =>
        Promise.all(
          (await fs.readdir("/proc/self/fd")).map((fd) => fs.readlink(`/proc/self/fd/${fd}`).catch(() => "")),
        ),
      )
      expect(links.filter((item) => item === dir || item.startsWith(`${dir}${path.sep}`))).toHaveLength(0)
    }),
  )

  it.live("allows the exact bounded PHP read shape with a truthful action", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "CalendarController.php")
      yield* put(filepath, "<?php\nfinal class CalendarController {}\n")
      const captured = asks()
      const args = { filePath: filepath, offset: 1, limit: 20 }

      const result = yield* exec(dir, args, captured.next)
      const request = captured.items.at(-1)
      const action = resolveReviewAction({
        builtin: true,
        identity: "read",
        arguments: args,
        directory: dir,
        requested: request?.action,
      })
      const snapshot = buildPermissionReviewSnapshot({
        permission: "read",
        origin: "tool",
        patterns: request?.patterns,
        metadata: request?.metadata,
        action,
        trusted: [{ source: "human", text: "Read the calendar refresh implementation" }],
        untrusted: [],
        contextSafeForGate: true,
      })

      expect(result.output).toContain("CalendarController")
      expect(action).toMatchObject({
        identity: "read",
        cwd: dir,
        complete: true,
        arguments: {
          filePath: filepath,
          offset: 1,
          limit: 20,
          target: "CalendarController.php",
          mode: "pinned-project-text-v4",
          bindingId: expect.stringMatching(/^[0-9a-f]{32}$/u),
          instructionFilesAbsent: true,
          instructionWatch: "linux-inotify-v1",
          effects: [],
        },
      })
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "read",
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

  it.live("keeps four ordinary Calendar PHP reads on the committed generic path", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const names = ["CalendarController.php", "CalendarRefresh.php", "PushUpdates.php", "CalendarConfig.php"]
      for (const name of names) yield* put(path.join(dir, name), `<?php\n// ${name}\n`)

      for (const name of names) {
        const captured = asks()
        const args = { filePath: path.join(dir, name), offset: 1, limit: 20 }
        const result = yield* exec(dir, args, captured.next)
        const action = resolveReviewAction({
          builtin: true,
          identity: "read",
          arguments: args,
          directory: dir,
          requested: captured.items.at(-1)?.action,
        })
        expect(result.output).toContain(name)
        expect(action.complete).toBe(true)
        expect(action.arguments).toMatchObject({
          mode: "pinned-project-text-v4",
          bindingId: expect.stringMatching(/^[0-9a-f]{32}$/u),
          instructionWatch: "linux-inotify-v1",
        })
      }
    }),
  )

  it.live("uses unlinkable opaque binding IDs without serialising content commitments", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "CalendarOpaque.php")
      const content = "<?php\n// identical content\n"
      yield* put(filepath, content)
      const captured = asks()
      const args = { filePath: filepath, offset: 1, limit: 20 }

      yield* exec(dir, args, captured.next)
      yield* exec(dir, args, captured.next)

      const snapshots = captured.items
        .filter((item) => item.permission === "read")
        .map((request) =>
          buildPermissionReviewSnapshot({
            permission: "read",
            origin: "tool",
            patterns: request.patterns,
            metadata: request.metadata,
            action: resolveReviewAction({
              builtin: true,
              identity: "read",
              arguments: args,
              directory: dir,
              requested: request.action,
            }),
            trusted: [{ source: "human", text: "Read the calendar implementation" }],
            untrusted: [],
            contextSafeForGate: true,
          }),
        )
      const bindingIds = snapshots.map((snapshot) => {
        const argumentsValue = snapshot.action.arguments
        if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue))
          throw new Error("read snapshot arguments were not captured")
        return Reflect.get(argumentsValue, "bindingId")
      })
      const serialised = JSON.stringify(snapshots)
      expect(bindingIds).toHaveLength(2)
      expect(bindingIds[0]).toMatch(/^[0-9a-f]{32}$/u)
      expect(bindingIds[1]).toMatch(/^[0-9a-f]{32}$/u)
      expect(bindingIds[0]).not.toBe(bindingIds[1])
      expect(serialised).not.toContain(createHash("sha256").update(content).digest("hex"))
      expect(serialised).not.toMatch(
        /contentDigest|generationDigest|directoryGenerationDigest|ctimeNs|mtimeNs|mountID/u,
      )
    }),
  )

  it.live("keeps a PHP read below nested instructions on the legacy human-gated path", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const nested = path.join(dir, "module")
      yield* Effect.promise(() => fs.mkdir(nested))
      yield* put(path.join(nested, "AGENTS.md"), "Nested instructions\n")
      const filepath = path.join(nested, "Calendar.php")
      yield* put(filepath, "<?php\n// nested\n")
      const captured = asks()

      yield* exec(dir, { filePath: filepath, offset: 1, limit: 20 }, captured.next)

      expect(captured.items.find((item) => item.permission === "read")?.action).toBeUndefined()
    }),
  )

  it.live("uses replacement decoding for invalid UTF-8 on the pinned path", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "Invalid.php")
      yield* Effect.promise(() => fs.writeFile(filepath, Buffer.from([0x3c, 0x3f, 0x70, 0x68, 0x70, 0x0a, 0xff, 0x0a])))

      const result = yield* exec(dir, { filePath: filepath, offset: 1, limit: 20 }, asks().next)
      expect(result.output).toContain("�")
    }),
  )

  it.live("splits lone carriage returns on the pinned path", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "Carriage.php")
      yield* put(filepath, "<?php\rfirst\rsecond\r")

      const result = yield* exec(dir, { filePath: filepath, offset: 1, limit: 20 }, asks().next)
      expect(result.output).toContain("first")
      expect(result.output).toContain("second")
      expect(result.output).not.toContain("first\rsecond")
    }),
  )

  it.live("fails closed when the validated path is replaced during permission", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "Calendar.php")
      const moved = path.join(dir, "Calendar.original.php")
      yield* put(filepath, "<?php\n// pinned original\n")
      const captured = asks()
      const next = {
        ...captured.next,
        ask: (request: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
          Effect.promise(async () => {
            captured.items.push(request)
            await fs.rename(filepath, moved)
            await Bun.write(filepath, "<?php\n// substituted content\n")
          }),
      }

      const error = yield* fail(dir, { filePath: filepath, offset: 1, limit: 20 }, next)

      expect(error.message).toMatch(/generation changed|instruction watch changed/u)
      const links = yield* Effect.promise(async () =>
        Promise.all(
          (await fs.readdir("/proc/self/fd")).map((fd) => fs.readlink(`/proc/self/fd/${fd}`).catch(() => "")),
        ),
      )
      expect(links.some((item) => item.includes("Calendar.original.php"))).toBe(false)
    }),
  )

  it.live("closes the pinned descriptor when permission fails", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "nested", "Denied.php")
      const baseline = yield* Effect.promise(inotifyWatchCount)
      yield* put(filepath, "<?php\n// denied\n")
      const next = {
        ...asks().next,
        ask: () => Effect.die(new Error("permission denied")),
      }

      yield* Effect.exit(exec(dir, { filePath: filepath, offset: 1, limit: 20 }, next))
      const links = yield* Effect.promise(async () =>
        Promise.all(
          (await fs.readdir("/proc/self/fd")).map((fd) => fs.readlink(`/proc/self/fd/${fd}`).catch(() => "")),
        ),
      )
      expect(links.some((item) => item.includes("Denied.php"))).toBe(false)
      expect(yield* Effect.promise(inotifyWatchCount)).toBeLessThanOrEqual(baseline)
    }),
  )

  it.live("returns to the fd baseline when a pinned read is cancelled", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "nested", "Cancelled.php")
      const watchBaseline = yield* Effect.promise(inotifyWatchCount)
      yield* put(filepath, "<?php\n// cancelled\n")
      const entered = yield* Deferred.make<void>()
      const next = {
        ...asks().next,
        ask: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }

      const fiber = yield* exec(dir, { filePath: filepath, offset: 1, limit: 20 }, next).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)

      const links = yield* Effect.promise(async () =>
        Promise.all(
          (await fs.readdir("/proc/self/fd")).map((fd) => fs.readlink(`/proc/self/fd/${fd}`).catch(() => "")),
        ),
      )
      expect(links.filter((item) => item === dir || item.startsWith(`${dir}${path.sep}`)).length).toBe(0)
      expect(yield* Effect.promise(inotifyWatchCount)).toBeLessThanOrEqual(watchBaseline)
    }),
  )

  it.live("keeps symlinked PHP files on the legacy human-gated path", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const dir = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const target = path.join(outside, "Secret.php")
      const filepath = path.join(dir, "Linked.php")
      yield* put(target, "<?php\n// outside\n")
      yield* Effect.promise(() => fs.symlink(target, filepath))
      const captured = asks()

      yield* exec(dir, { filePath: filepath, offset: 1, limit: 20 }, captured.next)

      const read = captured.items.find((item) => item.permission === "read")
      expect(read?.action).toBeUndefined()
      expect(
        resolveReviewAction({
          builtin: true,
          identity: "read",
          arguments: { filePath: filepath, offset: 1, limit: 20 },
          directory: dir,
          requested: read?.action,
        }).complete,
      ).toBe(false)
    }),
  )

  it.live("keeps PHP files below a symlinked directory on the legacy human-gated path", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const dir = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const target = path.join(outside, "Secret.php")
      const linked = path.join(dir, "linked")
      yield* put(target, "<?php\n// outside\n")
      yield* Effect.promise(() => fs.symlink(outside, linked, "dir"))
      const captured = asks()

      yield* exec(dir, { filePath: path.join(linked, "Secret.php"), offset: 1, limit: 20 }, captured.next)

      expect(captured.items.find((item) => item.permission === "read")?.action).toBeUndefined()
    }),
  )

  it.live("keeps hard-linked PHP files on the legacy human-gated path", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const dir = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const target = path.join(outside, "Secret.php")
      const linked = path.join(dir, "Linked.php")
      yield* put(target, "<?php\n// outside\n")
      yield* Effect.promise(() => fs.link(target, linked))
      const captured = asks()

      yield* exec(dir, { filePath: linked, offset: 1, limit: 20 }, captured.next)

      expect(captured.items.find((item) => item.permission === "read")?.action).toBeUndefined()
    }),
  )

  it.live("keeps oversized PHP files on the legacy human-gated path", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "Oversized.php")
      yield* Effect.promise(() => Bun.write(filepath, Buffer.alloc(1024 * 1024 + 1, 0x61)))
      const captured = asks()

      yield* exec(dir, { filePath: filepath, offset: 1, limit: 20 }, captured.next)

      expect(captured.items.find((item) => item.permission === "read")?.action).toBeUndefined()
    }),
  )

  it.live("keeps descriptor consumption bounded if the file grows after permission", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "Growing.php")
      yield* put(filepath, "<?php\n// initially small\n")
      const next = {
        ...asks().next,
        ask: () => Effect.promise(() => fs.truncate(filepath, 1024 * 1024 + 1)),
      }

      const error = yield* fail(dir, { filePath: filepath, offset: 1, limit: 20 }, next)

      expect(error.message).toMatch(/generation changed|instruction watch changed/u)
    }),
  )

  it.live("fails closed on same-size rewrites, shrink and link-generation changes", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const cases: readonly [string, (filepath: string) => Promise<void>][] = [
        [
          "same-size rewrite",
          async (filepath) => {
            const current = await fs.readFile(filepath)
            await fs.writeFile(filepath, Buffer.alloc(current.length, 0x78))
          },
        ],
        ["shrink", (filepath) => fs.truncate(filepath, 3)],
        [
          "persistent hard link",
          async (filepath) => {
            await fs.link(filepath, path.join(outside, "persistent-hard-link.php"))
          },
        ],
      ]
      for (const [name, mutate] of cases) {
        const filepath = path.join(dir, `${name.replaceAll(" ", "-")}.php`)
        yield* put(filepath, "<?php\n// original content\n")
        const error = yield* fail(
          dir,
          { filePath: filepath, offset: 1, limit: 20 },
          {
            ...asks().next,
            ask: () => Effect.promise(() => mutate(filepath)),
          },
        )
        expect(error.message).toMatch(/generation changed|instruction watch changed/u)
      }
      const filepath = path.join(dir, "temporary-hard-link.php")
      yield* put(filepath, "<?php\n// original content\n")
      const exit = yield* Effect.exit(
        exec(
          dir,
          { filePath: filepath, offset: 1, limit: 20 },
          {
            ...asks().next,
            ask: () =>
              Effect.promise(async () => {
                const alias = path.join(outside, "temporary-hard-link.php")
                await fs.link(filepath, alias)
                await fs.unlink(alias)
              }),
          },
        ),
      )
      if (Exit.isSuccess(exit)) expect(exit.value.output).toContain("original content")
      else expect(String(exit.cause)).toContain("generation changed")
    }),
  )

  it.live("fails closed while a bound project file is being rewritten", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "Concurrent.php")
      yield* Effect.promise(() => fs.writeFile(filepath, Buffer.alloc(1024 * 1024, 0x61)))
      const bound = yield* Effect.promise(() => bindProjectTextFile(dir, filepath))
      expect(bound).toBeDefined()
      if (!bound) return

      const started = Promise.withResolvers<void>()
      const writing = (async () => {
        for (let count = 0; count < 16; count++) {
          await fs.writeFile(filepath, Buffer.alloc(1024 * 1024, count % 2 ? 0x62 : 0x63))
          if (count === 0) started.resolve()
        }
      })()
      try {
        yield* Effect.promise(() => started.promise)
        const exit = yield* Effect.exit(Effect.promise(() => readBoundProjectTextFile(bound)))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(String(exit.cause)).toMatch(/generation changed|instruction watch changed/u)
      } finally {
        yield* Effect.promise(() => writing.then(() => undefined))
        yield* Effect.promise(() => closeBoundProjectTextFile(bound))
      }
    }),
  )

  it.live("content commitment catches a same-size rewrite when generation fields appear unchanged", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "Coarse.php")
      yield* put(filepath, "original")
      const bound = yield* Effect.promise(() => bindProjectTextFile(dir, filepath))
      expect(bound).toBeDefined()
      if (!bound) return
      try {
        yield* Effect.promise(() => fs.writeFile(filepath, "rewrite!"))
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve))))
        bound.instructionWatch.dirty = false
        const current = yield* Effect.promise(() => generation(bound.file))
        const error = yield* Effect.exit(
          Effect.promise(() => readBoundProjectTextFile({ ...bound, generation: current })),
        )
        expect(error._tag).toBe("Failure")
        if (error._tag === "Failure") expect(String(error.cause)).toContain("content changed")
      } finally {
        yield* Effect.promise(() => closeBoundProjectTextFile(bound))
      }
    }),
  )

  it.live("fails closed when nested instruction state changes during permission", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      for (const temporary of [false, true]) {
        const nested = path.join(dir, temporary ? "temporary" : "persistent")
        const filepath = path.join(nested, "Calendar.php")
        const instruction = path.join(nested, "AGENTS.md")
        yield* put(filepath, "<?php\n// private implementation\n")
        const error = yield* fail(
          dir,
          { filePath: filepath, offset: 1, limit: 20 },
          {
            ...asks().next,
            ask: () =>
              Effect.promise(async () => {
                await fs.writeFile(instruction, "changed instructions\n")
                if (temporary) await fs.unlink(instruction)
              }),
          },
        )
        expect(error.message).toContain("instruction watch changed")
      }
    }),
  )

  it.live("fails closed when a retained descendant directory is replaced during permission", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* tmpdirScoped()
      const nested = path.join(dir, "module")
      const moved = path.join(dir, "module-original")
      const filepath = path.join(nested, "Calendar.php")
      yield* put(filepath, "<?php\n// original\n")
      const error = yield* fail(
        dir,
        { filePath: filepath, offset: 1, limit: 20 },
        {
          ...asks().next,
          ask: () =>
            Effect.promise(async () => {
              await fs.rename(nested, moved)
              await fs.mkdir(nested)
            }),
        },
      )
      expect(error.message).toContain("instruction watch changed")
    }),
  )
})

describe("tool.read external_directory permission", () => {
  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

        yield* exec(dir, { filePath: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([path.relative(dir, full(target))])
      }),
    )
  }

  it.live("uses worktree-relative path for read permission so user rules match like edit/write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "src", "secret.ts"), "shh")

      const { items, next } = asks()
      yield* exec(dir, { filePath: path.join(dir, "src", "secret.ts") }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns).toEqual([path.join("src", "secret.ts")])
    }),
  )

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { filePath: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const [filename, shouldAsk] of cases) {
        it.live(`${filename} asks=${shouldAsk}`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const asked = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new PermissionV1.DeniedError({ ruleset: info.permission })
                        }
                      }
                    }),
                }

                yield* run({ filePath: path.join(dir, filename) }, next)
                return asked
              }),
            )

            expect(asked).toBe(shouldAsk)
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  it.instance("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const base = yield* load(path.join(FIXTURES_DIR, "models-api.json"))
      const target = 60 * 1024
      const content = base.length >= target ? base : base.repeat(Math.ceil(target / base.length))
      yield* put(path.join(test.directory, "large.json"), content)

      const result = yield* run({ filePath: path.join(test.directory, "large.json") })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(result.output).toContain("Use offset=")
    }),
  )

  it.instance("stops streaming after the byte cap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "huge.txt")
      const content = `${"x".repeat(80)}\n`.repeat(50_000)
      yield* put(filepath, content)

      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Output capped at")
      expect(counter.bytes).toBeLessThan(Buffer.byteLength(content, "utf-8") / 2)
    }),
  )

  it.instance("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(test.directory, "many-lines.txt"), lines)

      const result = yield* run({ filePath: path.join(test.directory, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing lines 1-10 of 100")
      expect(result.output).toContain("Use offset=11")
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.instance("does not truncate small file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "small.txt"), "hello world")

      const result = yield* run({ filePath: path.join(test.directory, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file")
      expect(result.metadata.display).toMatchObject({
        type: "file",
        path: path.join(test.directory, "small.txt"),
        text: "hello world",
        lineStart: 1,
        lineEnd: 1,
        totalLines: 1,
        truncated: false,
      })
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { filePath: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain("End of file - total 0 lines")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "dir"), offset: 6, limit: 5 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
      expect(result.metadata.display).toMatchObject({
        type: "directory",
        path: path.join(dir, "dir"),
        entries: ["file-5.txt", "file-6.txt", "file-7.txt", "file-8.txt", "file-9.txt"],
        offset: 6,
        totalEntries: 10,
        truncated: false,
      })
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 chars)")
      expect(result.output.length).toBeLessThan(3000)
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      expect(result.output).toBe("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { filePath: path.join(FIXTURES_DIR, "large-image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { filePath: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )

  it.live("falls through unsupported image mime types to text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const cases = [
        ["image.bmp", "BM text content"],
        ["photo.tiff", "II text content"],
        ["photo.avif", "avif text content"],
      ] as const

      for (const item of cases) {
        yield* put(path.join(dir, item[0]), item[1])
        const result = yield* exec(dir, { filePath: path.join(dir, item[0]) })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain(item[1])
      }
    }),
  )
})

describe("tool.read loaded instructions", () => {
  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).toContain("test content")
      expect(result.output).toContain("system-reminder")
      expect(result.output).toContain("Test Instructions")
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { filePath: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )
})
