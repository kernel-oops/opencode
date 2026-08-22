import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { ConfigBashPermissionEvaluatorV1 } from "@opencode-ai/core/v1/config/bash-permission-evaluator"
import { createHash } from "node:crypto"
import { readlinkSync } from "node:fs"
import path from "node:path"
import { chmod, mkdir, open, readdir, readlink, rename, symlink, type FileHandle } from "node:fs/promises"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { BashPermissionEvaluator } from "@/permission/bash-evaluator"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const env = AppNodeBuilder.build(LayerNode.group([BashPermissionEvaluator.node, CrossSpawnSpawner.node]))
const it = testEffect(env)
const identity = {
  implementation: "test-evaluator",
  version: "1.2.3",
  commit: "0123456789abcdef",
  protocol: "opencode-bash-v1",
  platform: process.platform,
}
const executable = (code: string) => `#!/bin/bash
exec /usr/bin/env -u PWD -u SHLVL ${process.execPath} -e '${code.replaceAll("'", "'\\''")}' -- "$@"
`
const checker = `
const args = process.argv.slice(1)
const policyDescriptor = "/proc/self/fd/4"
const policyText = await Bun.file(policyDescriptor).text()
const policy = JSON.parse(policyText)
const hang = async (capture, closeDescriptors = false) => {
  if (closeDescriptors) {
    const fs = await import("node:fs")
    fs.closeSync(3)
    fs.closeSync(4)
  }
  process.on("SIGTERM", () => {})
  const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM",()=>{}); await new Promise(()=>{})'], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  await Bun.sleep(100)
  await Bun.write(capture, JSON.stringify({ parent: process.pid, child: child.pid }))
  await new Promise(() => {})
}
const successfulDescendant = async (capture) => {
  const fs = await import("node:fs/promises")
  const { spawn } = await import("node:child_process")
  const ready = capture + ".ready"
  const term = capture + ".term"
  const childCode = 'const fs=require("node:fs");try{fs.closeSync(3)}catch{};try{fs.closeSync(4)}catch{};process.on("SIGTERM",()=>fs.writeFileSync(' + JSON.stringify(term) + ',"term"));fs.writeFileSync(' + JSON.stringify(ready) + ',"ready");setInterval(()=>{},10000)'
  const child = spawn(process.execPath, ["-e", childCode], { stdio: ["ignore", "ignore", "ignore", "ignore", "ignore"] })
  while (!(await Bun.file(ready).exists())) await Bun.sleep(5)
  await Bun.write(capture, JSON.stringify({
    parent: process.pid,
    child: child.pid,
    descriptors: [await fs.readlink("/proc/self/fd/3"), await fs.readlink("/proc/self/fd/4")],
  }))
}
if (args.length === 1 && args[0] === "--version-json") {
  if (policy.hangIdentityCapture) await hang(policy.hangIdentityCapture)
  if (policy.closedIdentityCapture) await hang(policy.closedIdentityCapture, true)
  if (policy.successfulIdentityCapture) await successfulDescendant(policy.successfulIdentityCapture)
  if (policy.replaceExecutable) {
    const replacement = policy.executable + ".replacement"
    await Bun.write(replacement, await Bun.file("/proc/self/fd/3").text())
    await (await import("node:fs/promises")).chmod(replacement, 0o700)
    await (await import("node:fs/promises")).rename(replacement, policy.executable)
  }
  if (policy.replacePolicy) {
    const replacement = policy.policy + ".replacement"
    await Bun.write(replacement, policyText)
    await (await import("node:fs/promises")).rename(replacement, policy.policy)
  }
  if (policy.replaceParent) {
    await (await import("node:fs/promises")).rename(policy.parent, policy.parent + ".real")
    await (await import("node:fs/promises")).symlink(policy.parent + ".real", policy.parent)
  }
  process.stdout.write(JSON.stringify(${JSON.stringify(identity)}))
  process.exit(0)
}
const configIndex = args.indexOf("--config")
if (args[configIndex + 1] !== policyDescriptor) process.exit(91)
const input = await Bun.stdin.text()
if (policy.capture) await Bun.write(policy.capture, JSON.stringify({ args, env: process.env, input, cwd: process.cwd() }))
if (policy.delay) await Bun.sleep(policy.delay)
if (policy.hangCapture) await hang(policy.hangCapture)
if (policy.closedPolicyCapture) await hang(policy.closedPolicyCapture, true)
if (policy.successfulPolicyCapture) await successfulDescendant(policy.successfulPolicyCapture)
if (policy.stderr) process.stderr.write(policy.stderr)
if (policy.raw !== undefined) process.stdout.write(policy.raw)
else process.stdout.write(JSON.stringify({ decision: policy.decision ?? "allow", reason: policy.reason ?? "fixed" }))
process.exit(policy.exit ?? 0)
`
const source = executable(checker)

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

const fixture = (
  policyValue:
    | Record<string, unknown>
    | ((paths: {
        executable: string
        policy: string
        parent: string
        directory: string
      }) => Record<string, unknown>) = {},
  executableSource = source,
) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const parent = path.join(directory, "checker")
    const executable = path.join(parent, "evaluator")
    const policy = path.join(parent, "policy.json")
    const policyText = JSON.stringify(
      typeof policyValue === "function" ? policyValue({ executable, policy, parent, directory }) : policyValue,
    )
    yield* Effect.promise(async () => {
      await mkdir(parent)
      await Bun.write(executable, executableSource)
      await chmod(executable, 0o700)
      await Bun.write(policy, policyText)
    })
    return {
      directory,
      executable,
      policy,
      parent,
      config: {
        mode: "enforce",
        executable,
        policy,
        executable_sha256: digest(executableSource),
        policy_sha256: digest(policyText),
        expected: identity,
        timeout_seconds: 2,
        capacity: 4,
        max_input_bytes: 256 * 1024,
        max_output_bytes: 4 * 1024,
      } satisfies ConfigBashPermissionEvaluatorV1.Active,
    }
  })

const action = (cwd: string, command = "git status") => ({
  identity: "bash",
  arguments: { command, timeout: 120_000, workdir: cwd, shell: "/bin/bash" },
  cwd,
  complete: true,
})

const waitForFile = async (file: string) => {
  const deadline = Date.now() + 5_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() >= deadline) throw new Error("checker did not create its capture file")
    await Bun.sleep(5)
  }
}

const expectProcessesGone = async (file: string) => {
  const pids = (await Bun.file(file).json()) as { parent: number; child: number }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const deadline = Date.now() + 5_000
  while ((alive(pids.parent) || alive(pids.child)) && Date.now() < deadline) await Bun.sleep(10)
  expect(alive(pids.parent)).toBe(false)
  expect(alive(pids.child)).toBe(false)
}

const openDescriptorTargets = async () => {
  const result: Array<string> = []
  for (const entry of await readdir("/proc/self/fd")) {
    try {
      result.push(await readlink(`/proc/self/fd/${entry}`))
    } catch {
      // Descriptor closed between listing and inspection.
    }
  }
  return result
}

const anonymousSnapshotTargets = async () =>
  (await openDescriptorTargets()).filter((target) => target.includes("(deleted)")).toSorted()

it.effect("invokes the exact argv with a minimal environment and canonical action", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const capture = path.join(directory, "capture.json")
    const test = yield* fixture({ capture, decision: "allow" })
    const evaluator = yield* BashPermissionEvaluator.Service
    const run = yield* evaluator.prepare({ config: test.config, action: action(directory) })
    expect(run.admitted).toBe(true)
    expect(yield* run.result).toEqual({ decision: "allow" })
    const observed = yield* Effect.promise(() => Bun.file(capture).json())
    expect(observed.args).toEqual(["--opencode", "--config", "/proc/self/fd/4", "--no-telemetry"])
    expect(observed.input).toBe(JSON.stringify({ tool: "bash", command: "git status", cwd: directory }))
    expect(observed.cwd).toBe("/")
    expect(observed.env).toEqual({ HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" })
  }),
)

it.effect("fails closed for incomplete or mismatched canonical actions", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const invalid of [
      undefined,
      { ...action(test.directory), complete: false },
      { ...action(test.directory), identity: "read" },
      { ...action(test.directory), cwd: "/different" },
      { ...action("relative") },
      { ...action(test.directory), extra: "unexpected" },
      { ...action(test.directory), arguments: { command: "git status", workdir: test.directory } },
    ]) {
      const run = yield* evaluator.prepare({ config: test.config, action: invalid })
      expect(run.admitted).toBe(false)
      expect(yield* run.result).toEqual({ failure: "input" })
    }
  }),
)

it.effect("checks file hashes and exact executable identity before evaluation", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const config of [
      { ...test.config, executable_sha256: "0".repeat(64) },
      { ...test.config, policy_sha256: "0".repeat(64) },
      ...Object.keys(identity).map((field) => ({
        ...test.config,
        expected: { ...identity, [field]: "wrong" },
      })),
    ]) {
      const run = yield* evaluator.prepare({ config, action: action(test.directory) })
      expect("failure" in (yield* run.result)).toBe(true)
    }
  }),
)

it.live("closes the snapshot descriptor when post-open validation throws", () =>
  Effect.gen(function* () {
    const before = yield* Effect.promise(() => anonymousSnapshotTargets())
    const probe = yield* Effect.promise(() => open(import.meta.path, "r"))
    const prototype = Object.getPrototypeOf(probe) as object
    const original = Reflect.get(prototype, "stat")
    yield* Effect.promise(() => probe.close())
    if (typeof original !== "function") throw new Error("FileHandle.stat is unavailable")
    let anonymousStats = 0
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const replacement = function (this: FileHandle, ...args: ReadonlyArray<unknown>) {
          try {
            if (readlinkSync(`/proc/self/fd/${this.fd}`).includes("(deleted)")) {
              anonymousStats++
              if (anonymousStats === 2) return Promise.reject(new Error("injected snapshot validation failure"))
            }
          } catch {
            // Preserve the real operation for descriptors which disappeared.
          }
          return Reflect.apply(original, this, args)
        }
        if (!Reflect.set(prototype, "stat", replacement)) throw new Error("could not install FileHandle fault")
      }),
      () => Effect.sync(() => void Reflect.set(prototype, "stat", original)),
    )

    const test = yield* fixture()
    const evaluator = yield* BashPermissionEvaluator.Service
    const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
    expect(yield* run.result).toEqual({ failure: "integrity" })
    yield* run.settled
    expect(anonymousStats).toBe(2)
    expect(yield* Effect.promise(() => anonymousSnapshotTargets())).toEqual(before)
  }),
)

it.effect("binds verified objects across executable, policy, and parent replacement races", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const replacement of ["replaceExecutable", "replacePolicy", "replaceParent"] as const) {
      const test = yield* fixture((paths) => ({ ...paths, [replacement]: true }))
      const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
      expect(yield* run.result).toEqual({ failure: "integrity" })
    }
  }),
)

it.effect("rejects symlinks and malformed, duplicate, trailing, oversized, or noisy identity output", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const [stdout, stderr = ""] of [
      ["not-json"],
      [
        '{"implementation":"test","implementation":"duplicate","version":"1","commit":"c","protocol":"p","platform":"x"}',
      ],
      [JSON.stringify(identity) + " trailing"],
      ["x".repeat(4 * 1024 + 1)],
      [JSON.stringify(identity), "diagnostic"],
    ]) {
      const executableSource = executable(
        `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)})`,
      )
      const test = yield* fixture({}, executableSource)
      const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
      expect("failure" in (yield* run.result)).toBe(true)
    }

    for (const field of ["executable", "policy"] as const) {
      const test = yield* fixture()
      const target = `${test[field]}.regular`
      yield* Effect.promise(async () => {
        await rename(test[field], target)
        await symlink(target, test[field])
      })
      const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
      expect(yield* run.result).toEqual({ failure: "integrity" })
    }

    const parent = yield* fixture()
    yield* Effect.promise(async () => {
      await rename(parent.parent, `${parent.parent}.regular`)
      await symlink(`${parent.parent}.regular`, parent.parent)
    })
    const parentRun = yield* evaluator.prepare({ config: parent.config, action: action(parent.directory) })
    expect(yield* parentRun.result).toEqual({ failure: "integrity" })
  }),
)

it.effect("rejects non-JSON whitespace in every protocol position", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    const forbidden = ["\u000b", "\u000c", "\u00a0", "\ufeff"]
    const validIdentity = JSON.stringify(identity)
    const validDecision = JSON.stringify({ decision: "allow", reason: "fixed" })
    for (const character of forbidden) {
      for (const stdout of [
        character + validIdentity,
        `{${character}${validIdentity.slice(1)}`,
        validIdentity + character,
        JSON.stringify({ ...identity, implementation: `test${character}evaluator` }),
      ]) {
        const test = yield* fixture({}, executable(`process.stdout.write(${JSON.stringify(stdout)})`))
        const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
        expect("failure" in (yield* run.result)).toBe(true)
      }
      for (const raw of [
        character + validDecision,
        `{${character}${validDecision.slice(1)}`,
        validDecision + character,
        JSON.stringify({ decision: "allow", reason: `fix${character}ed` }),
      ]) {
        const test = yield* fixture({ raw })
        const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
        expect("failure" in (yield* run.result)).toBe(true)
      }
    }
  }),
)

it.effect("strictly rejects malformed, duplicate, trailing, oversized, and noisy output", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const policy of [
      { raw: "not-json" },
      { raw: '{"decision":"allow","decision":"deny","reason":"x"}' },
      { raw: '{"decision":"allow","reason":"x"} trailing' },
      { raw: '{"decision":"approve","reason":"x"}' },
      { raw: '{"decision":"allow","reason":"x","extra":"x"}' },
      { raw: '{"decision":"noop","error":"invalid OpenCode input"}' },
      { raw: "x".repeat(4 * 1024 + 1) },
      { decision: "allow", stderr: "secret diagnostic" },
    ]) {
      const test = yield* fixture(policy)
      const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
      expect("failure" in (yield* run.result)).toBe(true)
    }
  }),
)

it.live("enforces input limits, timeout, cancellation, and actual-settlement capacity", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    const oversized = yield* fixture()
    const rejected = yield* evaluator.prepare({
      config: { ...oversized.config, max_input_bytes: 8 },
      action: action(oversized.directory),
    })
    expect(yield* rejected.result).toEqual({ failure: "input" })

    const slow = yield* fixture({ delay: 5_000 })
    const first = yield* evaluator.prepare({
      config: { ...slow.config, timeout_seconds: 0.05, capacity: 1 },
      action: action(slow.directory),
    })
    const result = yield* first.result.pipe(Effect.forkScoped)
    yield* Effect.promise(() => Bun.sleep(100))
    expect(yield* Fiber.join(result)).toEqual({ failure: "timeout" })
    const occupied = yield* evaluator.prepare({
      config: { ...slow.config, timeout_seconds: 0.05, capacity: 1 },
      action: action(slow.directory),
    })
    if (!first.isSettled()) expect(yield* occupied.result).toEqual({ failure: "capacity" })
    yield* first.settled

    const cancelled = yield* evaluator.prepare({ config: slow.config, action: action(slow.directory) })
    const fibre = yield* cancelled.result.pipe(Effect.forkScoped)
    yield* Effect.promise(() => Bun.sleep(50))
    yield* Fiber.interrupt(fibre)
    yield* cancelled.settled
    expect(cancelled.isSettled()).toBe(true)
  }),
)

it.effect(
  "cleans successful identity and policy descendants before settlement and descriptor release",
  () =>
    Effect.gen(function* () {
      const evaluator = yield* BashPermissionEvaluator.Service
      for (const stage of ["successfulIdentityCapture", "successfulPolicyCapture"] as const) {
        const directory = yield* tmpdirScoped()
        const capture = path.join(directory, `${stage}.json`)
        const test = yield* fixture({ [stage]: capture })
        const run = yield* evaluator.prepare({
          config: { ...test.config, capacity: 100 },
          action: action(test.directory),
        })
        const result = yield* run.result.pipe(Effect.forkScoped)
        yield* Effect.promise(() => waitForFile(capture))
        yield* Effect.promise(() => waitForFile(`${capture}.term`))
        const observed = yield* Effect.promise(
          () => Bun.file(capture).json() as Promise<{ parent: number; child: number; descriptors: Array<string> }>,
        )
        expect(run.isSettled()).toBe(false)
        expect(
          (yield* Effect.promise(() => openDescriptorTargets())).filter((target) =>
            observed.descriptors.includes(target),
          ),
        ).toHaveLength(2)
        const occupied = yield* evaluator.prepare({
          config: { ...test.config, capacity: 1 },
          action: action(test.directory),
        })
        expect(yield* occupied.result).toEqual({ failure: "capacity" })
        expect(run.isSettled()).toBe(false)
        expect(result.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(result)).toEqual({ decision: "allow" })
        yield* run.settled
        expect(run.isSettled()).toBe(true)
        yield* Effect.promise(() => expectProcessesGone(capture))
        expect(
          (yield* Effect.promise(() => openDescriptorTargets())).some((target) =>
            observed.descriptors.includes(target),
          ),
        ).toBe(false)

        const fast = yield* fixture()
        const released = yield* evaluator.prepare({
          config: { ...fast.config, capacity: 1 },
          action: action(fast.directory),
        })
        expect(yield* released.result).toEqual({ decision: "allow" })
      }
    }),
  15_000,
)

it.live(
  "force-kills SIGTERM-ignoring process groups before settlement and capacity release",
  () =>
    Effect.gen(function* () {
      const evaluator = yield* BashPermissionEvaluator.Service
      for (const stage of [
        "hangIdentityCapture",
        "hangCapture",
        "closedIdentityCapture",
        "closedPolicyCapture",
      ] as const) {
        const directory = yield* tmpdirScoped()
        const capture = path.join(directory, `${stage}.json`)
        const hanging = yield* fixture({ [stage]: capture })
        const first = yield* evaluator.prepare({
          config: { ...hanging.config, timeout_seconds: 0.5, capacity: 100 },
          action: action(hanging.directory),
        })
        yield* Effect.promise(() => waitForFile(capture))
        expect(yield* first.result).toEqual({ failure: "timeout" })
        const occupied = yield* evaluator.prepare({
          config: { ...hanging.config, capacity: 1 },
          action: action(hanging.directory),
        })
        expect(yield* occupied.result).toEqual({ failure: "capacity" })
        yield* first.settled
        expect(first.isSettled()).toBe(true)
        yield* Effect.promise(() => expectProcessesGone(capture))
      }

      const fast = yield* fixture()
      const released = yield* evaluator.prepare({
        config: { ...fast.config, capacity: 100 },
        action: action(fast.directory),
      })
      expect(yield* released.result).toEqual({ decision: "allow" })
    }),
  15_000,
)

it.live(
  "aborts and settles evaluator work when its service scope is disposed",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const capture = path.join(directory, "started.json")
      const slow = yield* fixture({ hangCapture: capture })
      const run = yield* Effect.scoped(
        Effect.gen(function* () {
          const evaluator = yield* BashPermissionEvaluator.Service
          const active = yield* evaluator.prepare({
            config: { ...slow.config, capacity: 100 },
            action: action(slow.directory),
          })
          yield* Effect.promise(() => waitForFile(capture))
          return active
        }).pipe(Effect.provide(Layer.fresh(env))),
      )
      yield* run.settled
      expect(run.isSettled()).toBe(true)
      yield* Effect.promise(() => expectProcessesGone(capture))
    }),
  15_000,
)
