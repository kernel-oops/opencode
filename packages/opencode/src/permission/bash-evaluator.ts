import { ConfigBashPermissionEvaluatorV1 } from "@opencode-ai/core/v1/config/bash-permission-evaluator"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, normalize, parse, relative } from "node:path"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

export type Decision = "allow" | "ask" | "deny" | "noop"
export type Failure = "input" | "capacity" | "integrity" | "identity" | "protocol" | "process" | "timeout"
export type Result = { decision: Decision } | { failure: Failure }

export interface Run {
  readonly admitted: boolean
  readonly result: Effect.Effect<Result>
  readonly settled: Effect.Effect<void>
  readonly abort: () => void
  readonly isSettled: () => boolean
}

export interface Interface {
  readonly prepare: (input: {
    config: ConfigBashPermissionEvaluatorV1.Active
    action?: PermissionV1.ReviewAction
  }) => Effect.Effect<Run>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BashPermissionEvaluator") {}

interface Operation {
  readonly controller: AbortController
  settled: boolean
}

const operations = new Set<Operation>()
const ENVIRONMENT = { HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" }
const EXECUTABLE_FD = 3
const POLICY_FD = 4
const EXECUTABLE_PATH = `/proc/self/fd/${EXECUTABLE_FD}`
const POLICY_PATH = `/proc/self/fd/${POLICY_FD}`
const FORCE_KILL_AFTER = "250 millis"
const FORBIDDEN_JSON_WHITESPACE = /[\u000b\u000c\u00a0\ufeff]/u
// Linux defines O_TMPFILE as __O_TMPFILE | O_DIRECTORY. Node does not expose it.
const O_TMPFILE = 0o20200000

function unavailable(failure: Failure): Run {
  return {
    admitted: false,
    result: Effect.succeed({ failure }),
    settled: Effect.void,
    abort: () => {},
    isSettled: () => true,
  }
}

function flatObject(text: string): Record<string, string> | undefined {
  if (FORBIDDEN_JSON_WHITESPACE.test(text)) return
  let index = 0
  const skip = () => {
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
      index++
    }
  }
  const string = () => {
    skip()
    if (text[index] !== '"') return
    const start = index++
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2
        continue
      }
      if (text[index++] !== '"') continue
      try {
        const value: unknown = JSON.parse(text.slice(start, index))
        return typeof value === "string" && !FORBIDDEN_JSON_WHITESPACE.test(value) ? value : undefined
      } catch {
        return
      }
    }
  }

  skip()
  if (text[index++] !== "{") return
  const result: Record<string, string> = Object.create(null)
  skip()
  if (text[index] === "}") index++
  else {
    while (index < text.length) {
      const key = string()
      if (key === undefined || Object.hasOwn(result, key)) return
      skip()
      if (text[index++] !== ":") return
      const value = string()
      if (value === undefined) return
      result[key] = value
      skip()
      if (text[index] === "}") {
        index++
        break
      }
      if (text[index++] !== ",") return
    }
  }
  skip()
  return index === text.length ? result : undefined
}

function output(text: string): Result {
  const value = flatObject(text)
  if (!value || Object.keys(value).sort().join(",") !== "decision,reason") return { failure: "protocol" }
  if (!(["allow", "ask", "deny", "noop"] as const).includes(value.decision as Decision)) {
    return { failure: "protocol" }
  }
  if (Buffer.byteLength(value.reason, "utf8") > 512 || /[\r\n]/.test(value.reason)) return { failure: "protocol" }
  return { decision: value.decision as Decision }
}

function canonical(action: PermissionV1.ReviewAction | undefined) {
  if (!action) return
  const actionDescriptors = Object.getOwnPropertyDescriptors(action)
  if (Object.keys(actionDescriptors).sort().join(",") !== "arguments,complete,cwd,identity") return
  if (Object.values(actionDescriptors).some((item) => !("value" in item))) return
  if (action.identity !== "bash" || action.complete !== true || typeof action.cwd !== "string") return
  if (!isAbsolute(action.cwd)) return
  const args = action.arguments
  if (!args || typeof args !== "object" || Array.isArray(args)) return
  const descriptors = Object.getOwnPropertyDescriptors(args)
  if (Object.keys(descriptors).sort().join(",") !== "command,shell,timeout,workdir") return
  if (Object.values(descriptors).some((item) => !("value" in item))) return
  const values = args as Record<string, unknown>
  if (typeof values.command !== "string" || typeof values.workdir !== "string" || values.workdir !== action.cwd) return
  if (typeof values.shell !== "string" || typeof values.timeout !== "number" || !Number.isFinite(values.timeout)) return
  return { tool: "bash", command: values.command, cwd: action.cwd }
}

interface PathComponent {
  readonly path: string
  readonly device: string
  readonly inode: string
  readonly kind: "directory" | "file"
}

interface BoundFile {
  readonly original: FileHandle
  readonly snapshot: FileHandle
  readonly components: ReadonlyArray<PathComponent>
  readonly hash: string
}

interface BoundFiles {
  readonly executable: BoundFile
  readonly policy: BoundFile
}

async function inspectPath(file: string): Promise<ReadonlyArray<PathComponent>> {
  if (!isAbsolute(file) || normalize(file) !== file) throw new Error("path is not canonical")
  const root = parse(file).root
  const names = relative(root, file).split(/[\\/]/u).filter(Boolean)
  const paths = [root]
  for (const name of names) paths.push(join(paths.at(-1) ?? root, name))
  const result: Array<PathComponent> = []
  for (let index = 0; index < paths.length; index++) {
    const current = paths[index]
    const info = await lstat(current, { bigint: true })
    if (info.isSymbolicLink()) throw new Error("path component is a symbolic link")
    const final = index === paths.length - 1
    if (final ? !info.isFile() : !info.isDirectory()) throw new Error("path component has the wrong type")
    result.push({
      path: current,
      device: info.dev.toString(),
      inode: info.ino.toString(),
      kind: final ? "file" : "directory",
    })
  }
  return result
}

async function hashHandle(handle: FileHandle): Promise<string> {
  const digest = createHash("sha256")
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let position = 0
  while (true) {
    const read = await handle.read(chunk, 0, chunk.length, position)
    if (read.bytesRead === 0) break
    digest.update(chunk.subarray(0, read.bytesRead))
    position += read.bytesRead
  }
  return digest.digest("hex")
}

async function copySnapshot(source: FileHandle, mode: number) {
  const destination = await open(tmpdir(), constants.O_RDWR | O_TMPFILE, mode)
  const digest = createHash("sha256")
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let sourcePosition = 0
  let targetPosition = 0
  try {
    while (true) {
      const read = await source.read(chunk, 0, chunk.length, sourcePosition)
      if (read.bytesRead === 0) break
      const bytes = chunk.subarray(0, read.bytesRead)
      digest.update(bytes)
      sourcePosition += read.bytesRead
      let offset = 0
      while (offset < bytes.length) {
        const written = await destination.write(bytes, offset, bytes.length - offset, targetPosition)
        if (written.bytesWritten === 0) throw new Error("snapshot write made no progress")
        offset += written.bytesWritten
        targetPosition += written.bytesWritten
      }
    }
    await destination.sync()
    await destination.chmod(mode)
    const snapshot = await open(`/proc/self/fd/${destination.fd}`, constants.O_RDONLY)
    try {
      const destinationInfo = await destination.stat({ bigint: true })
      const snapshotInfo = await snapshot.stat({ bigint: true })
      if (
        destinationInfo.dev !== snapshotInfo.dev ||
        destinationInfo.ino !== snapshotInfo.ino ||
        !snapshotInfo.isFile()
      ) {
        throw new Error("snapshot descriptor mismatch")
      }
      return { hash: digest.digest("hex"), snapshot }
    } catch (error) {
      await snapshot.close().catch(() => {})
      throw error
    }
  } finally {
    await destination.close().catch(() => {})
  }
}

async function bindFile(file: string, expectedHash: string, mode: number): Promise<BoundFile> {
  const components = await inspectPath(file)
  const original = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let snapshot: FileHandle | undefined
  try {
    const final = components.at(-1)
    const info = await original.stat({ bigint: true })
    if (!final || !info.isFile() || info.dev.toString() !== final.device || info.ino.toString() !== final.inode) {
      throw new Error("opened file does not match inspected file")
    }
    const copied = await copySnapshot(original, mode)
    snapshot = copied.snapshot
    if (copied.hash !== expectedHash || (await hashHandle(original)) !== expectedHash) throw new Error("hash mismatch")
    if ((await hashHandle(snapshot)) !== expectedHash) throw new Error("snapshot mismatch")
    return { original, snapshot, components, hash: expectedHash }
  } catch (error) {
    await snapshot?.close().catch(() => {})
    await original.close().catch(() => {})
    throw error
  }
}

async function verifyBoundFile(bound: BoundFile) {
  const current = await inspectPath(bound.components.at(-1)?.path ?? "")
  if (
    current.length !== bound.components.length ||
    current.some((item, index) => {
      const expected = bound.components[index]
      return (
        !expected ||
        item.path !== expected.path ||
        item.device !== expected.device ||
        item.inode !== expected.inode ||
        item.kind !== expected.kind
      )
    })
  ) {
    throw new Error("path was replaced")
  }
  const final = bound.components.at(-1)
  const info = await bound.original.stat({ bigint: true })
  if (
    !final ||
    !info.isFile() ||
    info.dev.toString() !== final.device ||
    info.ino.toString() !== final.inode ||
    (await hashHandle(bound.original)) !== bound.hash ||
    (await hashHandle(bound.snapshot)) !== bound.hash
  ) {
    throw new Error("bound file changed")
  }
}

async function bindFiles(config: ConfigBashPermissionEvaluatorV1.Active): Promise<BoundFiles> {
  if (globalThis.process.platform !== "linux") throw new Error("bound evaluator files require Linux")
  const proc = await lstat("/proc/self/fd")
  if (!proc.isDirectory()) throw new Error("procfs file descriptors are unavailable")
  let executable: BoundFile | undefined
  let policy: BoundFile | undefined
  try {
    executable = await bindFile(config.executable, config.executable_sha256, 0o500)
    policy = await bindFile(config.policy, config.policy_sha256, 0o400)
    await verifyBoundFile(executable)
    await verifyBoundFile(policy)
    return { executable, policy }
  } catch (error) {
    await Promise.allSettled([
      executable?.original.close(),
      executable?.snapshot.close(),
      policy?.original.close(),
      policy?.snapshot.close(),
    ])
    throw error
  }
}

async function closeFiles(files: BoundFiles) {
  await Promise.allSettled([
    files.executable.original.close(),
    files.executable.snapshot.close(),
    files.policy.original.close(),
    files.policy.snapshot.close(),
  ])
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const owned = new Set<Operation>()

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const operation of owned) operation.controller.abort()
        owned.clear()
      }),
    )

    const prepare: Interface["prepare"] = Effect.fn("BashPermissionEvaluator.prepare")(function* (input) {
      const action = canonical(input.action)
      if (!action) return unavailable("input")
      const capacity = input.config.capacity ?? 4
      const maxInputBytes = input.config.max_input_bytes ?? 256 * 1024
      const maxOutputBytes = input.config.max_output_bytes ?? 4 * 1024
      const timeoutSeconds = input.config.timeout_seconds ?? 2
      const payload = JSON.stringify(action)
      if (Buffer.byteLength(payload, "utf8") > maxInputBytes) return unavailable("input")
      if (operations.size >= capacity) return unavailable("capacity")

      const controller = new AbortController()
      const operation: Operation = { controller, settled: false }
      operations.add(operation)
      owned.add(operation)

      const run = (files: BoundFiles, args: readonly string[], stdin?: string) =>
        appProcess.run(
          ChildProcess.make(EXECUTABLE_PATH, args, {
            cwd: "/",
            env: ENVIRONMENT,
            extendEnv: false,
            shell: false,
            detached: true,
            forceKillAfter: FORCE_KILL_AFTER,
            stdin: "ignore",
          }),
          {
            signal: controller.signal,
            stdin,
            maxOutputBytes,
            maxErrorBytes: maxOutputBytes,
            inheritedReadOnlyFds: [
              { child: EXECUTABLE_FD, parent: files.executable.snapshot.fd },
              { child: POLICY_FD, parent: files.policy.snapshot.fd },
            ],
          },
        )

      const verifyFiles = (files: BoundFiles) =>
        Effect.tryPromise({
          try: async () => {
            await verifyBoundFile(files.executable)
            await verifyBoundFile(files.policy)
          },
          catch: () => "integrity" as const,
        })

      const executeBound = (files: BoundFiles): Effect.Effect<Result> =>
        Effect.gen(function* () {
          if (input.config.expected.platform !== globalThis.process.platform) return { failure: "identity" as const }
          const first = yield* verifyFiles(files).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!first) return { failure: "integrity" as const }

          const version = yield* run(files, ["--version-json"]).pipe(Effect.exit)
          if (Exit.isFailure(version)) return { failure: "process" as const }
          if (
            version.value.exitCode !== 0 ||
            version.value.stdoutTruncated ||
            version.value.stderrTruncated ||
            version.value.stderr.length !== 0
          )
            return { failure: "identity" as const }
          const identity = flatObject(version.value.stdout.toString("utf8"))
          const expected = input.config.expected
          if (
            !identity ||
            Object.keys(identity).sort().join(",") !== "commit,implementation,platform,protocol,version" ||
            identity.implementation !== expected.implementation ||
            identity.version !== expected.version ||
            identity.commit !== expected.commit ||
            identity.protocol !== expected.protocol ||
            identity.platform !== expected.platform
          )
            return { failure: "identity" as const }

          const second = yield* verifyFiles(files).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (!second) return { failure: "integrity" as const }
          const evaluated = yield* run(files, ["--opencode", "--config", POLICY_PATH, "--no-telemetry"], payload).pipe(
            Effect.exit,
          )
          if (Exit.isFailure(evaluated)) return { failure: "process" as const }
          if (
            evaluated.value.exitCode !== 0 ||
            evaluated.value.stdoutTruncated ||
            evaluated.value.stderrTruncated ||
            evaluated.value.stderr.length !== 0
          )
            return { failure: "process" as const }
          return output(evaluated.value.stdout.toString("utf8"))
        })

      const execute = Effect.tryPromise({
        try: () => bindFiles(input.config),
        catch: () => "integrity" as const,
      }).pipe(
        Effect.flatMap((files) => executeBound(files).pipe(Effect.ensuring(Effect.promise(() => closeFiles(files))))),
        Effect.catch(() => Effect.succeed({ failure: "integrity" as const })),
      )

      const fibre = yield* execute.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            operation.settled = true
            operations.delete(operation)
            owned.delete(operation)
          }),
        ),
        Effect.forkDetach({ startImmediately: true }),
      )
      const joined = Fiber.await(fibre).pipe(
        Effect.flatMap((exit) => (Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))),
      )
      const result = joined.pipe(
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
        Effect.timeoutOrElse({
          duration: timeoutSeconds * 1_000,
          orElse: () => Effect.sync(() => controller.abort()).pipe(Effect.as({ failure: "timeout" as const })),
        }),
      )
      return {
        admitted: true,
        result,
        settled: Fiber.await(fibre).pipe(Effect.asVoid),
        abort: () => controller.abort(),
        isSettled: () => operation.settled,
      }
    })

    return Service.of({ prepare })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [AppProcess.node] })

export * as BashPermissionEvaluator from "./bash-evaluator"
