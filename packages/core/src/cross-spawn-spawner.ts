import type * as Arr from "effect/Array"
import { NodeFileSystem, NodeSink, NodeStream } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
} from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { PassThrough } from "node:stream"
import launch from "cross-spawn"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem, path } from "./effect/app-node-platform"

export interface InheritedReadOnlyFd {
  readonly child: number
  readonly parent: number
}

const inheritedReadOnlyFds = new WeakMap<ChildProcess.StandardCommand, ReadonlyArray<InheritedReadOnlyFd>>()

export function registerInheritedReadOnlyFds(
  command: ChildProcess.StandardCommand,
  descriptors: ReadonlyArray<InheritedReadOnlyFd>,
) {
  inheritedReadOnlyFds.set(command, descriptors)
}

const toError = (err: unknown): Error => (err instanceof globalThis.Error ? err : new globalThis.Error(String(err)))

const toTag = (err: NodeJS.ErrnoException): PlatformError.SystemErrorTag => {
  switch (err.code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
      return "BadResource"
    case "ENOTDIR":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    case "ELOOP":
      return "BadResource"
    default:
      return "Unknown"
  }
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []

  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }

  walk(command)
  if (commands.length === 0) throw new Error("flatten produced empty commands array")
  const [head, ...tail] = commands
  return {
    commands: [head, ...tail] as Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand>,
    opts,
  }
}

const toPlatformError = (
  method: string,
  err: NodeJS.ErrnoException,
  command: ChildProcess.Command,
): PlatformError.PlatformError => {
  const cmd = flatten(command)
    .commands.map((x) => `${x.command} ${x.args.join(" ")}`)
    .join(" | ")
  return PlatformError.systemError({
    _tag: toTag(err),
    module: "ChildProcess",
    method,
    pathOrDescriptor: cmd,
    syscall: err.syscall,
    cause: err,
  })
}

type ExitSignal = Deferred.Deferred<readonly [code: number | null, signal: NodeJS.Signals | null]>

interface ProcessStat {
  readonly group: number
  readonly session: number
  readonly started: string
}

interface ProcessGroupIdentity {
  readonly leader: number
  readonly group: number
  readonly session: number
  readonly started: string
}

function processStat(pid: number): ProcessStat | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8")
    const end = value.lastIndexOf(")")
    if (end < 0) return
    const fields = value
      .slice(end + 2)
      .trim()
      .split(/ +/u)
    const group = Number(fields[2])
    const session = Number(fields[3])
    const started = fields[19]
    if (!Number.isSafeInteger(group) || !Number.isSafeInteger(session) || !started) return
    return { group, session, started }
  } catch {
    return
  }
}

function processGroupIdentity(proc: NodeChildProcess.ChildProcess): ProcessGroupIdentity | undefined {
  if (globalThis.process.platform !== "linux" || !proc.pid) return
  const stat = processStat(proc.pid)
  if (!stat || stat.group !== proc.pid || stat.session !== proc.pid) return
  return { leader: proc.pid, group: stat.group, session: stat.session, started: stat.started }
}

function ownsProcessGroup(identity: ProcessGroupIdentity) {
  const leader = processStat(identity.leader)
  // A live PID with different birth or session data is a reused leader PID.
  // Do not fall through and infer ownership from other numeric matches.
  if (leader)
    return leader.group === identity.group && leader.session === identity.session && leader.started === identity.started

  // A detached session is stable for the lifetime of its remaining members.
  // Requiring both captured values prevents a reused group ID in another
  // session from being treated as this child after its leader is reaped. This
  // is lifecycle cleanup rather than containment: a child can deliberately
  // escape by joining another group or session.
  try {
    let member = false
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
      const pid = Number(entry.name)
      const stat = processStat(pid)
      if (!stat) continue
      if (pid === identity.leader && stat.started !== identity.started) return false
      if (stat.group === identity.group && stat.session === identity.session) member = true
    }
    return member
  } catch {
    return false
  }
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const cwd = Effect.fnUntraced(function* (opts: ChildProcess.CommandOptions) {
    if (Predicate.isUndefined(opts.cwd)) return undefined
    yield* fs.access(opts.cwd)
    return path.resolve(opts.cwd)
  })

  const env = (opts: ChildProcess.CommandOptions) =>
    opts.extendEnv ? { ...globalThis.process.env, ...opts.env } : opts.env

  const input = (x: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(x) ? "pipe" : x

  const output = (x: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(x) ? "pipe" : x

  const stdin = (opts: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const cfg: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(opts.stdin)) return cfg
    if (typeof opts.stdin === "string") return { ...cfg, stream: opts.stdin }
    if (Stream.isStream(opts.stdin)) return { ...cfg, stream: opts.stdin }
    return {
      stream: opts.stdin.stream,
      encoding: opts.stdin.encoding ?? cfg.encoding,
      endOnDone: opts.stdin.endOnDone ?? cfg.endOnDone,
    }
  }

  const stdio = (opts: ChildProcess.CommandOptions, key: "stdout" | "stderr"): ChildProcess.StdoutConfig => {
    const cfg = opts[key]
    if (Predicate.isUndefined(cfg)) return { stream: "pipe" }
    if (typeof cfg === "string") return { stream: cfg }
    if (Sink.isSink(cfg)) return { stream: cfg }
    return { stream: cfg.stream }
  }

  const fds = (opts: ChildProcess.CommandOptions) => {
    if (Predicate.isUndefined(opts.additionalFds)) return []
    return Object.entries(opts.additionalFds)
      .flatMap(([name, config]) => {
        const fd = ChildProcess.parseFdName(name)
        return Predicate.isUndefined(fd) ? [] : [{ fd, config }]
      })
      .toSorted((a, b) => a.fd - b.fd)
  }

  const stdios = (
    sin: ChildProcess.StdinConfig,
    sout: ChildProcess.StdoutConfig,
    serr: ChildProcess.StderrConfig,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
    inherited: ReadonlyArray<InheritedReadOnlyFd>,
  ): NodeChildProcess.StdioOptions => {
    const pipe = (x: NodeChildProcess.IOType | undefined) =>
      process.platform === "win32" && x === "pipe" ? "overlapped" : x
    const arr: Array<NodeChildProcess.IOType | number | undefined> = [
      pipe(input(sin.stream)),
      pipe(output(sout.stream)),
      pipe(output(serr.stream)),
    ]
    if (extra.length === 0 && inherited.length === 0) return arr as NodeChildProcess.StdioOptions
    const max = [...extra.map((x) => x.fd), ...inherited.map((x) => x.child)].reduce((acc, fd) => Math.max(acc, fd), 2)
    for (let i = 3; i <= max; i++) arr[i] = "ignore"
    for (const x of extra) arr[x.fd] = pipe("pipe")
    for (const x of inherited) arr[x.child] = x.parent
    return arr as NodeChildProcess.StdioOptions
  }

  const setupFds = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ) {
    if (extra.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }
    }

    const ins = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outs = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const x of extra) {
      const node = proc.stdio[x.fd]
      switch (x.config.type) {
        case "input": {
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (node && "write" in node) {
            sink = NodeSink.fromWritable({
              evaluate: () => node,
              onError: (err) => toPlatformError(`fromWritable(fd${x.fd})`, toError(err), command),
              endOnDone: true,
            })
          }
          if (x.config.stream) yield* Effect.forkScoped(Stream.run(x.config.stream, sink))
          ins.set(x.fd, sink)
          break
        }
        case "output": {
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (node && "read" in node) {
            const tap = new PassThrough()
            node.on("error", (err) => tap.destroy(toError(err)))
            node.pipe(tap)
            stream = NodeStream.fromReadable({
              evaluate: () => tap,
              onError: (err) => toPlatformError(`fromReadable(fd${x.fd})`, toError(err), command),
            })
          }
          if (x.config.sink) stream = Stream.transduce(stream, x.config.sink)
          outs.set(x.fd, stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => ins.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outs.get(fd) ?? Stream.empty,
    }
  })

  const setupStdin = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    cfg: ChildProcess.StdinConfig,
  ) =>
    Effect.suspend(() => {
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(proc.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => proc.stdin!,
          onError: (err) => toPlatformError("fromWritable(stdin)", toError(err), command),
          endOnDone: cfg.endOnDone,
          encoding: cfg.encoding === "utf-16le" ? "utf16le" : cfg.encoding,
        })
      }
      if (Stream.isStream(cfg.stream)) return Effect.as(Effect.forkScoped(Stream.run(cfg.stream, sink)), sink)
      return Effect.succeed(sink)
    })

  const setupOutput = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    out: ChildProcess.StdoutConfig,
    err: ChildProcess.StderrConfig,
  ) => {
    let stdout = proc.stdout
      ? NodeStream.fromReadable({
          evaluate: () => proc.stdout!,
          onError: (cause) => toPlatformError("fromReadable(stdout)", toError(cause), command),
        })
      : Stream.empty
    let stderr = proc.stderr
      ? NodeStream.fromReadable({
          evaluate: () => proc.stderr!,
          onError: (cause) => toPlatformError("fromReadable(stderr)", toError(cause), command),
        })
      : Stream.empty

    if (Sink.isSink(out.stream)) stdout = Stream.transduce(stdout, out.stream)
    if (Sink.isSink(err.stream)) stderr = Stream.transduce(stderr, err.stream)

    return { stdout, stderr, all: Stream.merge(stdout, stderr) }
  }

  const spawn = (command: ChildProcess.StandardCommand, opts: NodeChildProcess.SpawnOptions) =>
    Effect.callback<
      readonly [NodeChildProcess.ChildProcess, ExitSignal, ProcessGroupIdentity | undefined],
      PlatformError.PlatformError
    >((resume) => {
      const signal = Deferred.makeUnsafe<readonly [code: number | null, signal: NodeJS.Signals | null]>()
      const proc = launch(command.command, command.args, opts)
      let end = false
      let exit: readonly [code: number | null, signal: NodeJS.Signals | null] | undefined
      proc.on("error", (err) => {
        resume(Effect.fail(toPlatformError("spawn", err, command)))
      })
      proc.on("exit", (...args) => {
        exit = args
      })
      proc.on("close", (...args) => {
        if (end) return
        end = true
        Deferred.doneUnsafe(signal, Exit.succeed(exit ?? args))
      })
      proc.on("spawn", () => {
        try {
          const group = opts.detached ? processGroupIdentity(proc) : undefined
          if (globalThis.process.platform === "linux" && opts.detached && command.options.forceKillAfter && !group) {
            proc.kill("SIGKILL")
            return resume(
              Effect.fail(
                toPlatformError("processGroup", new Error("Failed to identify detached process group"), command),
              ),
            )
          }
          resume(Effect.succeed([proc, signal, group]))
        } catch (err) {
          proc.kill("SIGKILL")
          resume(Effect.fail(toPlatformError("processGroup", toError(err), command)))
        }
      })
      return Effect.sync(() => {
        proc.kill("SIGTERM")
      })
    })

  const killGroup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
    group = proc.pid,
  ) => {
    if (globalThis.process.platform === "win32") {
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        NodeChildProcess.exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true }, (err) => {
          if (err) return resume(Effect.fail(toPlatformError("kill", toError(err), command)))
          resume(Effect.void)
        })
      })
    }

    return Effect.try({
      try: () => {
        globalThis.process.kill(-group!, signal)
      },
      catch: (err) => toPlatformError("kill", toError(err), command),
    })
  }

  const killOne = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) =>
    Effect.suspend(() => {
      if (proc.kill(signal)) return Effect.void
      return Effect.fail(toPlatformError("kill", new Error("Failed to kill child process"), command))
    })

  const timeout =
    (
      proc: NodeChildProcess.ChildProcess,
      command: ChildProcess.StandardCommand,
      opts: ChildProcess.KillOptions | undefined,
    ) =>
    <A, E, R>(
      f: (
        command: ChildProcess.StandardCommand,
        proc: NodeChildProcess.ChildProcess,
        signal: NodeJS.Signals,
      ) => Effect.Effect<A, E, R>,
    ) => {
      const signal = opts?.killSignal ?? "SIGTERM"
      if (Predicate.isUndefined(opts?.forceKillAfter)) return f(command, proc, signal)
      return Effect.timeoutOrElse(f(command, proc, signal), {
        duration: opts.forceKillAfter,
        orElse: () => f(command, proc, "SIGKILL"),
      })
    }

  const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
    const opt = from ?? "stdout"
    switch (opt) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        const fd = ChildProcess.parseFdName(opt)
        return Predicate.isNotUndefined(fd) ? handle.getOutputFd(fd) : handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> = Effect.fnUntraced(
    function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const sin = stdin(command.options)
          const sout = stdio(command.options, "stdout")
          const serr = stdio(command.options, "stderr")
          const extra = fds(command.options)
          const inherited = inheritedReadOnlyFds.get(command) ?? []
          const dir = yield* cwd(command.options)

          const [proc, signal, group] = yield* Effect.acquireRelease(
            spawn(command, {
              cwd: dir,
              env: env(command.options),
              stdio: stdios(sin, sout, serr, extra, inherited),
              detached: command.options.detached ?? process.platform !== "win32",
              shell: command.options.shell,
              windowsHide: process.platform === "win32",
            }),
            Effect.fnUntraced(function* ([proc, signal, group]) {
              const done = yield* Deferred.isDone(signal)
              if (process.platform === "win32") {
                if (done) return yield* Effect.void
                return yield* Effect.ignore(timeout(proc, command, command.options)(killGroup))
              }
              const send = (s: NodeJS.Signals) =>
                Effect.suspend(() => {
                  if (process.platform !== "linux") return Effect.as(killGroup(command, proc, s), true)
                  if (group) {
                    if (!ownsProcessGroup(group)) return Effect.succeed(false)
                    return Effect.as(killGroup(command, proc, s, group.group), true)
                  }
                  if (done || proc.exitCode !== null) return Effect.succeed(false)
                  return Effect.as(killOne(command, proc, s), true)
                })
              const sig = command.options.killSignal ?? "SIGTERM"
              const forceKillAfter = command.options.forceKillAfter
              if (!forceKillAfter) {
                if (done) return yield* Effect.void
                return yield* Effect.ignore(send(sig).pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid))
              }
              return yield* Effect.ignore(
                Effect.gen(function* () {
                  const sent = yield* send(sig)
                  if (!sent) return
                  if (process.platform !== "linux" && process.platform !== "win32") {
                    // POSIX has no portable equivalent of Linux /proc identity
                    // checks. Preserve the historical bounded group escalation:
                    // the leader exiting must not strand descendants.
                    yield* Effect.sleep(forceKillAfter)
                    yield* Effect.ignore(send("SIGKILL"))
                    if (!done) yield* Deferred.await(signal)
                    return
                  }
                  const exited = yield* Effect.raceFirst(
                    Effect.gen(function* () {
                      if (group) while (ownsProcessGroup(group)) yield* Effect.sleep("5 millis")
                      else if (!done) yield* Deferred.await(signal)
                      return true
                    }),
                    Effect.sleep(forceKillAfter).pipe(Effect.as(false)),
                  )
                  if (exited) return
                  yield* Effect.ignore(send("SIGKILL"))
                  if (!done) yield* Deferred.await(signal)
                  if (!group) return
                  while (ownsProcessGroup(group)) yield* Effect.sleep("5 millis")
                }),
              )
            }),
          )

          const fd = yield* setupFds(command, proc, extra)
          const out = setupOutput(command, proc, sout, serr)
          let ref = true
          return makeHandle({
            pid: ProcessId(proc.pid!),
            stdin: yield* setupStdin(command, proc, sin),
            stdout: out.stdout,
            stderr: out.stderr,
            all: out.all,
            getInputFd: fd.getInputFd,
            getOutputFd: fd.getOutputFd,
            isRunning: Effect.map(Deferred.isDone(signal), (done) => !done),
            exitCode: Effect.flatMap(Deferred.await(signal), ([code, signal]) => {
              if (Predicate.isNotNull(code)) return Effect.succeed(ExitCode(code))
              return Effect.fail(
                toPlatformError(
                  "exitCode",
                  new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                  command,
                ),
              )
            }),
            kill: (opts?: ChildProcess.KillOptions) => {
              const sig = opts?.killSignal ?? "SIGTERM"
              const send = (s: NodeJS.Signals) =>
                Effect.suspend(() => {
                  if (process.platform !== "linux")
                    return Effect.as(
                      Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s)),
                      true,
                    )
                  if (group) {
                    if (!ownsProcessGroup(group)) return Effect.succeed(false)
                    return Effect.as(killGroup(command, proc, s, group.group), true)
                  }
                  if (proc.exitCode !== null) return Effect.succeed(false)
                  return Effect.as(killOne(command, proc, s), true)
                })
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid)
              const forceKillAfter = opts?.forceKillAfter
              if (!forceKillAfter) return attempt
              return Effect.gen(function* () {
                const sent = yield* send(sig)
                if (!sent) return
                if (process.platform !== "linux" && process.platform !== "win32") {
                  // See the scope finaliser above: a successful leader exit is
                  // not evidence that its POSIX process group is empty.
                  yield* Effect.sleep(forceKillAfter)
                  yield* Effect.ignore(send("SIGKILL"))
                  if (!(yield* Deferred.isDone(signal))) yield* Deferred.await(signal)
                  return
                }
                const exited = yield* Effect.raceFirst(
                  Effect.gen(function* () {
                    if (group) while (ownsProcessGroup(group)) yield* Effect.sleep("5 millis")
                    else yield* Deferred.await(signal)
                    return true
                  }),
                  Effect.sleep(forceKillAfter).pipe(Effect.as(false)),
                )
                if (exited) return
                yield* Effect.ignore(send("SIGKILL"))
                if (!(yield* Deferred.isDone(signal))) yield* Deferred.await(signal)
                if (!group) return
                while (ownsProcessGroup(group)) yield* Effect.sleep("5 millis")
              }).pipe(Effect.asVoid)
            },
            unref: Effect.sync(() => {
              if (ref) {
                proc.unref()
                ref = false
              }
              return Effect.sync(() => {
                if (!ref) {
                  proc.ref()
                  ref = true
                }
              })
            }),
          })
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]
            const opts = flat.opts[i] ?? {}
            const sin = stdin(next.options)
            const stream = Stream.unwrap(Effect.map(handle, (x) => source(x, opts.from)))
            const to = opts.to ?? "stdin"
            if (to === "stdin") {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            const fd = ChildProcess.parseFdName(to)
            if (Predicate.isUndefined(fd)) {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            handle = spawnCommand(
              ChildProcess.make(next.command, next.args, {
                ...next.options,
                additionalFds: {
                  ...next.options.additionalFds,
                  [ChildProcess.fdName(fd) as `fd${number}`]: { type: "input", stream },
                },
              }),
            )
          }
          return yield* handle
        }
      }
    },
  )

  return makeSpawner(spawnCommand)
})

const layer: Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  ChildProcessSpawner,
  make,
)

export const node = makeGlobalNode({ service: ChildProcessSpawner, layer, deps: [filesystem, path] })

export * as CrossSpawnSpawner from "./cross-spawn-spawner"
