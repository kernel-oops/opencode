import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect } from "bun:test"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import * as TestClock from "effect/testing/TestClock"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance, tmpdirScoped, withTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { safeReviewValue } from "../../src/permission/review"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ],
)
const it = testEffect(env)

const rejectAll = (message?: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (const req of yield* permission.list()) {
      yield* permission.reply({
        requestID: req.id,
        reply: "reject",
        message,
      })
    }
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* Effect.gen(function* () {
      while (true) {
        const list = yield* permission.list()
        if (list.length === count) return list
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
  })

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected permission effect to fail")
  })

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

const permissionHook = (body: string) =>
  ["export default async () => ({", '  "permission.ask": async (input, output) => {', body, "  },", "})", ""].join("\n")

const withPlugins = (...sources: string[]) => ({
  git: true,
  init: (directory: string) =>
    Effect.promise(async () => {
      const plugins = await Promise.all(
        sources.map(async (source, index) => {
          const file = path.join(directory, `plugin-${index}.ts`)
          await Bun.write(file, source)
          return pathToFileURL(file).href
        }),
      )
      await Bun.write(
        path.join(directory, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: plugins }),
      )
    }),
})

test("safeReviewValue - canonicalises and redacts secret-bearing input", () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const result = safeReviewValue({
    z: "last",
    password: "do-not-expose",
    command: "curl -H 'Authorization: Bearer abc123' https://user:pass@example.com",
    cli: "--password command-secret",
    environment: "OPENAI_API_KEY=env-secret",
    cloudEnvironment: "AWS_SECRET_ACCESS_KEY=aws-env AWS_SESSION_TOKEN=session-env",
    cloudCli: "--secret-access-key cloud-cli",
    json: '{"token":"json-secret"}',
    a: { access_token: "hidden", keep: true },
    circular,
  })

  expect(result).toEqual({
    a: { access_token: "[REDACTED]", keep: true },
    circular: { self: "[CIRCULAR]" },
    cli: "--password [REDACTED]",
    cloudCli: "--secret-access-key [REDACTED]",
    cloudEnvironment: "AWS_SECRET_ACCESS_KEY=[REDACTED] AWS_SESSION_TOKEN=[REDACTED]",
    command: "curl -H 'Authorization: [REDACTED]' https://[REDACTED]@example.com",
    environment: "OPENAI_API_KEY=[REDACTED]",
    json: '{"token":"[REDACTED]"}',
    password: "[REDACTED]",
    z: "last",
  })
  expect(Object.keys(result as Record<string, unknown>)).toEqual([
    "a",
    "circular",
    "cli",
    "cloudCli",
    "cloudEnvironment",
    "command",
    "environment",
    "json",
    "password",
    "z",
  ])
})

test("safeReviewValue - redacts complete sensitive HTTP header values", () => {
  const result = safeReviewValue({
    digest: "Authorization: Digest username=x,response=secret",
    plain: "Authorization: definitely-secret",
    cookieHeader: "Cookie: session=secret; csrf=topsecret",
    proxy: "Proxy-Authorization: Custom proxy-secret",
    responseHeader: 'Set-Cookie: session="cookie-secret"; Path=/; HttpOnly',
    assignment: "Authorization=assignment-secret",
    command: "curl -H 'Authorization: Digest username=x,response=command-secret' https://example.com",
    quotedCommand: 'curl --header "Cookie: session=quoted-secret; csrf=quoted-csrf" https://example.com',
  })

  expect(result).toEqual({
    assignment: "Authorization=[REDACTED]",
    command: "curl -H 'Authorization: [REDACTED]' https://example.com",
    cookieHeader: "Cookie: [REDACTED]",
    digest: "Authorization: [REDACTED]",
    plain: "Authorization: [REDACTED]",
    proxy: "Proxy-Authorization: [REDACTED]",
    quotedCommand: 'curl --header "Cookie: [REDACTED]" https://example.com',
    responseHeader: "Set-Cookie: [REDACTED]",
  })
  const serialised = JSON.stringify(result)
  for (const secret of [
    "response=secret",
    "definitely-secret",
    "session=secret",
    "topsecret",
    "proxy-secret",
    "cookie-secret",
    "assignment-secret",
    "command-secret",
    "quoted-secret",
    "quoted-csrf",
  ]) {
    expect(serialised).not.toContain(secret)
  }
})

test("safeReviewValue - rejects accessors, proxies, unsafe keys, and non-plain values", () => {
  let getterCalls = 0
  let proxyCalls = 0
  const input: Record<string, unknown> = {
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    secretAccessKey: "cloud-secret",
    accessKeyId: "access-secret",
    sessionToken: "session-secret",
    created: new Date(0),
    proxied: new Proxy(
      {},
      {
        ownKeys() {
          proxyCalls++
          return []
        },
      },
    ),
  }
  Object.defineProperty(input, "dynamicSecret", {
    enumerable: true,
    get() {
      getterCalls++
      return "getter-secret"
    },
  })
  Object.defineProperty(input, "__proto__", { enumerable: true, value: "prototype-secret" })
  input[`secretAccessKey${"x".repeat(200)}`] = "long-key-secret"

  const result = safeReviewValue(input) as Record<string, unknown>

  expect(getterCalls).toBe(0)
  expect(proxyCalls).toBe(0)
  expect(Object.getPrototypeOf(result)).toBeNull()
  expect(result.AWS_SECRET_ACCESS_KEY).toBe("[REDACTED]")
  expect(result.secretAccessKey).toBe("[REDACTED]")
  expect(result.accessKeyId).toBe("[REDACTED]")
  expect(result.sessionToken).toBe("[REDACTED]")
  expect(result.dynamicSecret).toBe("[ACCESSOR]")
  expect(result.created).toBe("[UNSUPPORTED:object]")
  expect(result.proxied).toBe("[UNSUPPORTED:proxy]")
  expect(Object.keys(result).some((key) => key.startsWith("[UNSAFE_KEY_"))).toBe(true)
  expect(Object.keys(result).some((key) => key.startsWith("[LONG_KEY_"))).toBe(true)
  expect(JSON.stringify(result)).not.toContain("prototype-secret")
  expect(JSON.stringify(result)).not.toContain("long-key-secret")
})

const lineageLookup = (...nodes: Session.LineageNode[]) => {
  const entries = new Map(nodes.map((node) => [node.id, node]))
  return {
    get: (id: SessionID) => {
      const node = entries.get(id)
      return node ? Effect.succeed(node) : Effect.fail(new Error(`missing ${id}`))
    },
  }
}

test("resolveLineage - reports a complete root-to-child lineage", async () => {
  const root = SessionID.make("session_root")
  const parent = SessionID.make("session_parent")
  const child = SessionID.make("session_child")
  const result = await Effect.runPromise(
    Session.resolveLineage(lineageLookup({ id: root }, { id: parent, parentID: root }), {
      id: child,
      parentID: parent,
    }),
  )
  expect(result).toEqual({ parentID: parent, rootID: root, lineage: [root, parent, child], complete: true })
})

test("resolveLineage - marks a missing ancestor as incomplete without appending it", async () => {
  const missing = SessionID.make("session_missing")
  const child = SessionID.make("session_child")
  const result = await Effect.runPromise(Session.resolveLineage(lineageLookup(), { id: child, parentID: missing }))
  expect(result).toEqual({
    parentID: missing,
    lineage: [child],
    complete: false,
    reason: "missing_ancestor",
  })
})

test("resolveLineage - marks cycles as incomplete without claiming a root", async () => {
  const first = SessionID.make("session_first")
  const second = SessionID.make("session_second")
  const result = await Effect.runPromise(
    Session.resolveLineage(lineageLookup({ id: second, parentID: first }), { id: first, parentID: second }),
  )
  expect(result).toEqual({
    parentID: second,
    lineage: [second, first],
    complete: false,
    reason: "cycle",
  })
})

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = Permission.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = Permission.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = Permission.fromConfig({})
  expect(result).toEqual([])
})

test("fromConfig - expands tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = Permission.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = Permission.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

// Permission precedence follows config insertion order. `evaluate()` uses the
// last matching rule, so later config entries intentionally override earlier
// entries even when a wildcard appears after a specific permission.

test("fromConfig - preserves top-level config key order", () => {
  const wildcardFirst = Permission.fromConfig({ "*": "deny", bash: "allow" })
  const specificFirst = Permission.fromConfig({ bash: "allow", "*": "deny" })

  expect(wildcardFirst.map((r) => r.permission)).toEqual(["*", "bash"])
  expect(specificFirst.map((r) => r.permission)).toEqual(["bash", "*"])

  expect(Permission.evaluate("bash", "ls", wildcardFirst).action).toBe("allow")
  expect(Permission.evaluate("bash", "ls", specificFirst).action).toBe("deny")
})

test("fromConfig - wildcard acts as fallback when it appears before specifics", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow" })
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("ask")
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
})

test("fromConfig - top-level ordering is not sorted by wildcard specificity", () => {
  const ruleset = Permission.fromConfig({
    bash: "allow",
    "*": "ask",
    edit: "deny",
    "mcp_*": "allow",
  })
  expect(ruleset.map((r) => r.permission)).toEqual(["bash", "*", "edit", "mcp_*"])
})

test("fromConfig - sub-pattern insertion order inside a tool key is preserved", () => {
  const ruleset = Permission.fromConfig({ bash: { "*": "deny", "git *": "allow" } })
  expect(ruleset.map((r) => r.pattern)).toEqual(["*", "git *"])
  expect(Permission.evaluate("bash", "rm foo", ruleset).action).toBe("deny")
  expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("allow")
})

test("fromConfig - documented fallback-first example", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow", edit: "deny" })
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("deny")
  expect(Permission.evaluate("read", "foo.ts", ruleset).action).toBe("ask")
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = Permission.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = Permission.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  const defaults: PermissionV1.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  const defaults: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = Permission.evaluate("edit", "etc/passwd", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = Permission.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = Permission.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = Permission.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - later wildcard permission can override earlier specific permission", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: PermissionV1.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: PermissionV1.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  const result = Permission.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/apply_patch when edit denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = Permission.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = Permission.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

// ask tests

it.instance(
  "ask - resolves immediately when action is allow",
  () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - throws DeniedError when action is deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "ask - stays pending when action is ask",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "ask - adds request to pending list",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const items = yield* waitForPending(1)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
      })

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "ask - publishes asked event",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const seen = yield* Deferred.make<PermissionV1.Request>()
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type)
          Deferred.doneUnsafe(seen, Effect.succeed(event.data as PermissionV1.Request))
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      expect(
        yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission asked event")),
          }),
        ),
      ).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
      })

      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "ask - interruption while an asked listener is blocked clears pending state",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const entered = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const unsub = yield* events.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
      })
      yield* Effect.addFinalizer(() => unsub)

      const fiber = yield* ask({
        sessionID: SessionID.make("session_blocked_asked"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(entered).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new Error("timed out waiting for blocked asked listener")),
        }),
      )
      expect(yield* list()).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - fully static allow bypasses permission hook",
  () =>
    Effect.gen(function* () {
      yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(yield* list()).toHaveLength(0)
    }),
  withPlugins(permissionHook('    throw new Error("hook should not run")')),
)

it.instance(
  "ask - static deny cannot be overridden by permission hook",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  withPlugins(permissionHook('    output.status = "allow"')),
)

it.instance(
  "ask - permission hook receives trusted review context with redacted arguments",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rootID = SessionID.make("session_root")
      const childID = SessionID.make("session_child")

      yield* ask({
        id: PermissionV1.ID.make("per_context"),
        sessionID: childID,
        permission: "bash",
        patterns: ["echo ok", "curl --token pattern-secret example.com"],
        metadata: { accessToken: "metadata-secret", label: "visible" },
        always: ["echo ok", "--password always-secret"],
        tool: { messageID: MessageID.make("msg_context"), callID: "call_context" },
        ruleset: [{ permission: "bash", pattern: "echo *", action: "allow" }],
        review: {
          origin: "tool",
          agent: { name: "build", mode: "primary" },
          model: { providerID: "openai", modelID: "gpt-test" },
          session: { parentID: rootID, rootID, lineage: [rootID, childID], complete: true },
          arguments: {
            command: "curl -H 'Authorization: Bearer argument-secret' example.com",
            apiKey: "key-secret",
            nested: { password: "password-secret" },
          },
        },
      })

      const review = JSON.parse(yield* Effect.promise(() => Bun.file(path.join(test.directory, "review.json")).text()))
      expect(review).toMatchObject({
        id: "per_context",
        sessionID: childID,
        permission: "bash",
        patterns: ["echo ok", "curl --token pattern-secret example.com"],
        always: ["echo ok", "--password always-secret"],
        metadata: { accessToken: "metadata-secret", label: "visible" },
        tool: { messageID: "msg_context", callID: "call_context" },
        review: {
          policyVersion: "1",
          reviewID: "review_per_context",
          origin: "tool",
          project: { directory: test.directory, worktree: test.directory },
          session: { parentID: rootID, rootID, lineage: [rootID, childID], complete: true },
          agent: { name: "build", mode: "primary" },
          model: { providerID: "openai", modelID: "gpt-test" },
          arguments: {
            apiKey: "[REDACTED]",
            nested: { password: "[REDACTED]" },
          },
          rules: [
            {
              pattern: "echo ok",
              action: "allow",
              matched: { permission: "bash", pattern: "echo *", action: "allow" },
            },
            {
              pattern: "curl --token [REDACTED] example.com",
              action: "ask",
              matched: { permission: "bash", pattern: "*", action: "ask" },
            },
          ],
        },
      })
      expect(review.review.project.id).toBeTruthy()
      const reviewContext = JSON.stringify(review.review)
      expect(reviewContext).not.toContain("argument-secret")
      expect(reviewContext).not.toContain("key-secret")
      expect(reviewContext).not.toContain("password-secret")
      expect(reviewContext).not.toContain("pattern-secret")
      expect(JSON.stringify(review.metadata)).toContain("metadata-secret")
      expect(JSON.stringify(review.patterns)).toContain("pattern-secret")
      expect(JSON.stringify(review.always)).toContain("always-secret")

      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain("permission review")
      expect(logs).toContain('"result":"allow"')
      expect(logs).toContain('"fallbackToHuman":false')
      expect(logs).toContain('"reviewSettled":true')
      expect(logs).not.toContain("pattern-secret")
      expect(logs).not.toContain("argument-secret")
      expect(logs).not.toContain("metadata-secret")
    }),
  withPlugins(
    permissionHook(
      [
        '    await Bun.write(new URL("review.json", import.meta.url), JSON.stringify(input))',
        '    output.status = "allow"',
      ].join("\n"),
    ),
  ),
)

it.instance(
  "ask - permission hook sees an incomplete lineage when the current session is missing",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = SessionID.make("session_missing_current")
      yield* ask({
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      const context = JSON.parse(
        yield* Effect.promise(() => Bun.file(path.join(test.directory, "lineage.json")).text()),
      )
      expect(context).toEqual({ lineage: [sessionID], complete: false, reason: "missing_current" })
    }),
  withPlugins(
    permissionHook(
      [
        '    await Bun.write(new URL("lineage.json", import.meta.url), JSON.stringify(input.review.session))',
        '    output.status = "allow"',
      ].join("\n"),
    ),
  ),
)

it.instance(
  "ask - permission hook deny returns DeniedError",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
      expect(JSON.stringify(yield* TestConsole.logLines)).not.toContain("asking")
    }),
  withPlugins(permissionHook('    output.status = "deny"')),
)

it.instance(
  "ask - permission hook deny outranks a later allow",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
      expect(JSON.stringify(yield* TestConsole.logLines)).not.toContain("asking")
    }),
  withPlugins(permissionHook('    output.status = "deny"'), permissionHook('    output.status = "allow"')),
)

it.instance(
  "ask - permission hook deny outranks an earlier allow",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  withPlugins(permissionHook('    output.status = "allow"'), permissionHook('    output.status = "deny"')),
)

it.instance(
  "ask - permission hook deny outranks errors in either order",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  withPlugins(permissionHook('    throw new Error("failed first")'), permissionHook('    output.status = "deny"')),
)

it.instance(
  "ask - permission hook deny outranks a concurrently started later error",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      yield* Effect.gen(function* () {
        while (!(yield* Effect.promise(() => Bun.file(path.join(test.directory, "lower-priority-ran")).exists()))) {
          yield* Effect.sleep("10 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for concurrent permission hook")),
        }),
      )
    }),
  withPlugins(
    permissionHook('    output.status = "deny"'),
    permissionHook(
      [
        '    await Bun.write(new URL("lower-priority-ran", import.meta.url), "ran")',
        '    throw new Error("failed later")',
      ].join("\n"),
    ),
  ),
)

it.instance(
  "ask - a later deny bypasses an earlier hung hook while the hung work retains capacity",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const active = Array.from({ length: Permission.REVIEW_CAPACITY }, (_, index) =>
        PermissionV1.ID.make(`per_hung_deny_${index}`),
      )

      for (const id of active) {
        const err = yield* fail(
          ask({
            id,
            sessionID: SessionID.make(`session_${id}`),
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [],
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.fail(new Error(`timed out waiting for concurrent deny ${id}`)),
          }),
        )
        expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      }

      yield* Effect.gen(function* () {
        while (true) {
          const ready = yield* Effect.forEach(active, (id) =>
            Effect.all([
              Effect.promise(() => Bun.file(path.join(test.directory, `hung-${id}`)).exists()),
              Effect.promise(() => Bun.file(path.join(test.directory, `deny-${id}`)).exists()),
            ]),
          )
          if (ready.every(([hung, deny]) => hung && deny)) return
          yield* Effect.sleep("10 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for concurrent permission hooks")),
        }),
      )
      expect(yield* list()).toHaveLength(0)

      const overflowID = PermissionV1.ID.make("per_hung_deny_capacity")
      const overflow = yield* ask({
        id: overflowID,
        sessionID: SessionID.make("session_hung_deny_capacity"),
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect((yield* waitForPending(1)).map((item) => item.id)).toEqual([overflowID])
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, `hung-${overflowID}`)).exists())).toBe(
        false,
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, `deny-${overflowID}`)).exists())).toBe(
        false,
      )
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain('"result":"deny"')
      expect(logs).toContain('"reviewSettled":false')
      expect(logs).toContain('"result":"capacity"')
      expect(logs).toContain('"fallbackToHuman":true')
      yield* reply({ requestID: overflowID, reply: "reject" })
      yield* Fiber.await(overflow)
    }),
  withPlugins(
    permissionHook(
      [
        '    await Bun.write(new URL(`hung-${input.id}`, import.meta.url), "started")',
        "    return new Promise(() => {})",
      ].join("\n"),
    ),
    permissionHook(
      [
        '    await Bun.write(new URL(`deny-${input.id}`, import.meta.url), "started")',
        '    output.status = "deny"',
      ].join("\n"),
    ),
  ),
)

it.instance(
  "ask - permission hook deny outranks an invalid result",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  withPlugins(permissionHook('    output.status = "invalid"'), permissionHook('    output.status = "deny"')),
)

it.instance(
  "ask - permission hook deny outranks an earlier ask",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  withPlugins(permissionHook('    output.status = "ask"'), permissionHook('    output.status = "deny"')),
)

it.instance(
  "ask - one asking hook prevents automatic allow",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  withPlugins(permissionHook('    output.status = "allow"'), permissionHook('    output.status = "ask"')),
)

it.instance(
  "ask - an earlier asking hook also prevents automatic allow",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  withPlugins(permissionHook('    output.status = "ask"'), permissionHook('    output.status = "allow"')),
)

it.instance(
  "ask - an earlier permission hook error prevents a later automatic allow",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      expect(JSON.stringify(yield* TestConsole.logLines)).toContain('"result":"error"')
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  withPlugins(permissionHook('    throw new Error("failed first")'), permissionHook('    output.status = "allow"')),
)

it.instance(
  "ask - later permission hook failure falls back to ask and logs",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain("permission ask plugin failed")
      expect(logs).toContain('"result":"error"')
      expect(logs).toContain('"fallbackToHuman":true')
      expect(logs).toContain('"reviewSettled":true')
      expect(logs).toContain("asking")
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  withPlugins(
    permissionHook('    output.status = "allow"'),
    permissionHook('    throw new Error("later hook failed")'),
  ),
)

it.instance(
  "ask - invalid permission hook status falls back to human ask",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_invalid"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect((yield* waitForPending(1))[0]?.id).toBe(PermissionV1.ID.make("per_invalid"))
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain("permission ask plugin failed or returned invalid status")
      expect(logs).toContain('"result":"error"')
      expect(logs).toContain('"fallbackToHuman":true')
      expect(logs).toContain('"reviewSettled":true')
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  withPlugins(permissionHook('    output.status = "invalid"'), permissionHook('    output.status = "allow"')),
)

it.instance(
  "ask - permission hook status accessors cannot auto-approve",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect(yield* waitForPending(1)).toHaveLength(1)
      expect(JSON.stringify(yield* TestConsole.logLines)).toContain('"result":"error"')
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  withPlugins(
    permissionHook('    Object.defineProperty(output, "status", { get() { throw new Error("must not run") } })'),
  ),
)

it.effect("ask - timed out native hooks retain capacity until they actually settle", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const firstID = PermissionV1.ID.make("per_timeout")
    const marker = path.join(test.directory, `timeout-${firstID}`)
    const fiber = yield* ask({
      id: firstID,
      sessionID: SessionID.make("session_timeout"),
      permission: "bash",
      patterns: ["ls"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(Effect.forkScoped)

    while (!(yield* Effect.promise(() => Bun.file(marker).exists()))) yield* Effect.yieldNow
    expect(yield* list()).toHaveLength(0)
    yield* TestClock.adjust(Permission.REVIEW_TIMEOUT)

    const pending = yield* list()
    expect(pending.map((item) => item.id)).toEqual([firstID])
    const logs = JSON.stringify(yield* TestConsole.logLines)
    expect(logs).toContain('"result":"timeout"')
    expect(logs).toContain('"latencyMs":30000')
    expect(logs).toContain('"fallbackToHuman":true')
    expect(logs).toContain('"reviewSettled":false')

    const additional = Array.from({ length: Permission.REVIEW_CAPACITY - 1 }, (_, index) =>
      PermissionV1.ID.make(`per_timeout_${index}`),
    )
    const additionalFibers = yield* Effect.forEach(additional, (id) =>
      ask({
        id,
        sessionID: SessionID.make(`session_${id}`),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped),
    )
    while (true) {
      const ready = yield* Effect.forEach(additional, (id) =>
        Effect.promise(() => Bun.file(path.join(test.directory, `timeout-${id}`)).exists()),
      )
      if (ready.every(Boolean)) break
      yield* Effect.yieldNow
    }
    yield* TestClock.adjust(Permission.REVIEW_TIMEOUT)
    while ((yield* list()).length < Permission.REVIEW_CAPACITY) yield* Effect.yieldNow

    const overflowID = PermissionV1.ID.make("per_timeout_capacity")
    const overflow = yield* ask({
      id: overflowID,
      sessionID: SessionID.make("session_timeout_capacity"),
      permission: "bash",
      patterns: ["pwd"],
      metadata: {},
      always: [],
      ruleset: [],
    }).pipe(Effect.forkScoped)
    while ((yield* list()).length < Permission.REVIEW_CAPACITY + 1) yield* Effect.yieldNow
    expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, `timeout-${overflowID}`)).exists())).toBe(
      false,
    )
    expect(JSON.stringify(yield* TestConsole.logLines)).toContain('"result":"capacity"')

    yield* rejectAll()
    yield* Effect.forEach([fiber, ...additionalFibers, overflow], Fiber.await, { discard: true })
  }).pipe(
    withTmpdirInstance<never, never>(
      withPlugins(
        permissionHook(
          [
            '    await Bun.write(new URL(`timeout-${input.id}`, import.meta.url), "started")',
            "    return new Promise(() => {})",
          ].join("\n"),
        ),
      ),
    ),
  ),
)

it.instance(
  "ask - permission hook capacity immediately falls back to human ask",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const active = Array.from({ length: Permission.REVIEW_CAPACITY }, (_, index) =>
        PermissionV1.ID.make(`per_active_${index}`),
      )
      const fibers = yield* Effect.forEach(active, (id) =>
        ask({
          id,
          sessionID: SessionID.make(`session_${id}`),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }).pipe(Effect.forkScoped),
      )

      yield* Effect.gen(function* () {
        while (true) {
          const ready = yield* Effect.forEach(active, (id) =>
            Effect.promise(() => Bun.file(path.join(test.directory, `hook-${id}`)).exists()),
          )
          if (ready.every(Boolean)) return
          yield* Effect.yieldNow
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for permission hooks to occupy capacity")),
        }),
      )

      const overflowID = PermissionV1.ID.make("per_capacity")
      const overflow = yield* ask({
        id: overflowID,
        sessionID: SessionID.make("session_capacity"),
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect((yield* waitForPending(1)).map((item) => item.id)).toEqual([overflowID])
      expect(yield* Effect.promise(() => Bun.file(path.join(test.directory, `hook-${overflowID}`)).exists())).toBe(
        false,
      )
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain('"result":"capacity"')
      expect(logs).toContain('"fallbackToHuman":true')
      expect(logs).toContain('"reviewSettled":true')

      yield* reply({ requestID: overflowID, reply: "reject" })
      yield* Fiber.await(overflow)
      yield* Effect.forEach(fibers, Fiber.interrupt)

      const afterInterruptID = PermissionV1.ID.make("per_after_interrupt")
      const afterInterrupt = yield* ask({
        id: afterInterruptID,
        sessionID: SessionID.make("session_after_interrupt"),
        permission: "bash",
        patterns: ["whoami"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      expect((yield* waitForPending(1)).map((item) => item.id)).toEqual([afterInterruptID])
      expect(
        yield* Effect.promise(() => Bun.file(path.join(test.directory, `hook-${afterInterruptID}`)).exists()),
      ).toBe(false)
      yield* reply({ requestID: afterInterruptID, reply: "reject" })
      yield* Fiber.await(afterInterrupt)
      expect(yield* list()).toHaveLength(0)
    }),
  withPlugins(
    permissionHook(
      [
        '    await Bun.write(new URL(`hook-${input.id}`, import.meta.url), "started")',
        "    return new Promise(() => {})",
      ].join("\n"),
    ),
  ),
)

it.instance(
  "ask - permission hook cannot mutate nested pending request metadata",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { nested: { value: "original" } },
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending[0]?.metadata).toEqual({ nested: { value: "original" } })
      yield* rejectAll()
      yield* Fiber.await(fiber)
    }),
  withPlugins(permissionHook('    input.metadata.nested.value = "mutated"')),
)

it.instance(
  "ask - each permission hook receives isolated input and must independently allow",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { nested: { value: "original" } },
        always: ["ls"],
        ruleset: [],
      })
      const observed = JSON.parse(
        yield* Effect.promise(() => Bun.file(path.join(test.directory, "isolated-input.json")).text()),
      )
      expect(observed).toEqual({
        metadata: { nested: { value: "original" } },
        patterns: ["ls"],
        always: ["ls"],
      })
    }),
  withPlugins(
    permissionHook(
      [
        '    input.metadata.nested.value = "mutated"',
        '    input.patterns[0] = "mutated"',
        '    input.always[0] = "mutated"',
        '    output.status = "allow"',
      ].join("\n"),
    ),
    permissionHook(
      [
        '    await Bun.write(new URL("isolated-input.json", import.meta.url), JSON.stringify({ metadata: input.metadata, patterns: input.patterns, always: input.always }))',
        '    output.status = "allow"',
      ].join("\n"),
    ),
  ),
)

it.instance(
  "ask - interruption during permission hook leaves no request or asked event",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const marker = path.join(test.directory, "hook-started")
      let asked = 0
      const events = yield* EventV2Bridge.Service
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Permission.Event.Asked.type) asked++
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const fiber = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* Effect.gen(function* () {
        while (!(yield* Effect.promise(() => Bun.file(marker).exists()))) yield* Effect.sleep("10 millis")
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for permission hook")),
        }),
      )
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* list()).toHaveLength(0)
      expect(asked).toBe(0)
      const logs = JSON.stringify(yield* TestConsole.logLines)
      expect(logs).toContain('"result":"interrupted"')
      expect(logs).toContain('"fallbackToHuman":false')
      expect(logs).toContain('"reviewSettled":false')
    }),
  withPlugins(
    permissionHook(
      [
        '    await Bun.write(new URL("hook-started", import.meta.url), "started")',
        "    return new Promise(() => {})",
      ].join("\n"),
    ),
  ),
)

// reply tests

it.instance(
  "reply - once resolves the pending ask",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test1"), reply: "once" })
      yield* Fiber.join(fiber)
    }),
  { git: true },
)

it.instance(
  "reply - reject throws RejectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test2"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test2"), reply: "reject" })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - reject with message throws CorrectedError",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test2b"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({
        requestID: PermissionV1.ID.make("per_test2b"),
        reply: "reject",
        message: "Use a safer command",
      })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).toBeInstanceOf(PermissionV1.CorrectedError)
        expect(String(err)).toContain("Use a safer command")
      }
    }),
  { git: true },
)

it.instance(
  "reply - always persists approval and resolves",
  () =>
    Effect.gen(function* () {
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test3"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_test3"), reply: "always" })
      yield* Fiber.join(fiber)

      const result = yield* ask({
        sessionID: SessionID.make("session_test2"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - configured deny outranks a learned wildcard approval",
  () =>
    Effect.gen(function* () {
      const learned = yield* ask({
        id: PermissionV1.ID.make("per_learn_allow"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["*"],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)
      yield* reply({ requestID: PermissionV1.ID.make("per_learn_allow"), reply: "always" })
      yield* Fiber.join(learned)

      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "rm *", action: "deny" }],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "reply - reject cancels all pending for same session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test4a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test4b"),
        sessionID: SessionID.make("session_same"),
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test4a"), reply: "reject" })

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isFailure(ea)).toBe(true)
      expect(Exit.isFailure(eb)).toBe(true)
      if (Exit.isFailure(ea)) expect(Cause.squash(ea.cause)).toBeInstanceOf(PermissionV1.RejectedError)
      if (Exit.isFailure(eb)) expect(Cause.squash(eb.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - always resolves matching pending requests in same session",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test5a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test5b"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test5a"), reply: "always" })

      yield* Fiber.join(a)
      yield* Fiber.join(b)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "reply - always keeps other session pending",
  () =>
    Effect.gen(function* () {
      const a = yield* ask({
        id: PermissionV1.ID.make("per_test6a"),
        sessionID: SessionID.make("session_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      const b = yield* ask({
        id: PermissionV1.ID.make("per_test6b"),
        sessionID: SessionID.make("session_b"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(2)
      yield* reply({ requestID: PermissionV1.ID.make("per_test6a"), reply: "always" })

      yield* Fiber.join(a)
      expect((yield* list()).map((item) => item.id)).toEqual([PermissionV1.ID.make("per_test6b")])

      yield* rejectAll()
      yield* Fiber.await(b)
    }),
  { git: true },
)

it.instance(
  "reply - publishes replied event",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const seen = yield* Deferred.make<{
        sessionID: SessionID
        requestID: PermissionV1.ID
        reply: PermissionV1.Reply
      }>()

      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_test7"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      yield* waitForPending(1)

      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Replied.type)
          Deferred.doneUnsafe(
            seen,
            Effect.succeed(
              event.data as { sessionID: SessionID; requestID: PermissionV1.ID; reply: PermissionV1.Reply },
            ),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      yield* reply({ requestID: PermissionV1.ID.make("per_test7"), reply: "once" })
      yield* Fiber.join(fiber)
      expect(
        yield* Deferred.await(seen).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting for permission replied event")),
          }),
        ),
      ).toEqual({
        sessionID: SessionID.make("session_test"),
        requestID: PermissionV1.ID.make("per_test7"),
        reply: "once",
      })
    }),
  { git: true },
)

it.instance(
  "reply - settles and removes pending state before a replied listener can block",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const askFiber = yield* ask({
        id: PermissionV1.ID.make("per_blocked_replied"),
        sessionID: SessionID.make("session_blocked_replied"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)
      yield* waitForPending(1)

      const entered = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const unsub = yield* events.listen((event) => {
        if (event.type !== Permission.Event.Replied.type) return Effect.void
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
      })
      yield* Effect.addFinalizer(() => unsub)

      const replyFiber = yield* reply({ requestID: PermissionV1.ID.make("per_blocked_replied"), reply: "once" }).pipe(
        Effect.forkScoped,
      )
      yield* Deferred.await(entered).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new Error("timed out waiting for blocked replied listener")),
        }),
      )
      yield* Fiber.join(askFiber).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new Error("pending ask did not settle before replied publication")),
        }),
      )
      expect(yield* list()).toHaveLength(0)
      yield* Fiber.interrupt(replyFiber)
      const exit = yield* Fiber.await(replyFiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.live("permission requests stay isolated by directory", () =>
  Effect.gen(function* () {
    const one = yield* tmpdirScoped({ git: true })
    const two = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service

    const a = yield* store
      .provide(
        { directory: one },
        ask({
          id: PermissionV1.ID.make("per_dir_a"),
          sessionID: SessionID.make("session_dir_a"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      .pipe(Effect.forkScoped)

    const b = yield* store
      .provide(
        { directory: two },
        ask({
          id: PermissionV1.ID.make("per_dir_b"),
          sessionID: SessionID.make("session_dir_b"),
          permission: "bash",
          patterns: ["pwd"],
          metadata: {},
          always: [],
          ruleset: [],
        }),
      )
      .pipe(Effect.forkScoped)

    const onePending = yield* store.provide({ directory: one }, waitForPending(1))
    const twoPending = yield* store.provide({ directory: two }, waitForPending(1))

    expect(onePending).toHaveLength(1)
    expect(twoPending).toHaveLength(1)
    expect(onePending[0].id).toBe(PermissionV1.ID.make("per_dir_a"))
    expect(twoPending[0].id).toBe(PermissionV1.ID.make("per_dir_b"))

    yield* store.provide({ directory: one }, reply({ requestID: onePending[0].id, reply: "reject" }))
    yield* store.provide({ directory: two }, reply({ requestID: twoPending[0].id, reply: "reject" }))

    yield* Fiber.await(a)
    yield* Fiber.await(b)
  }),
)

it.instance(
  "pending permission rejects on instance dispose",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_dispose"),
        sessionID: SessionID.make("session_dispose"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      const ctx = yield* store.load({ directory: test.directory })
      yield* store.dispose(ctx)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "pending permission rejects on instance reload",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service
      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }).pipe(Effect.forkScoped)

      expect(yield* waitForPending(1)).toHaveLength(1)
      yield* store.reload({ directory: test.directory })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)

it.instance(
  "reply - fails for unknown requestID",
  () =>
    Effect.gen(function* () {
      const exit = yield* reply({ requestID: PermissionV1.ID.make("per_unknown"), reply: "once" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "Permission.NotFoundError", requestID: "per_unknown" })
      }
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - checks all patterns and stops on first deny",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { git: true },
)

it.instance(
  "ask - allows all patterns when all match allow rules",
  () =>
    Effect.gen(function* () {
      const result = yield* ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    }),
  { git: true },
)

it.instance(
  "ask - should deny even when an earlier pattern is ask",
  () =>
    Effect.gen(function* () {
      const err = yield* fail(
        ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "echo *", action: "ask" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      )

      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "ask - abort should clear pending request",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const store = yield* InstanceStore.Service

      const fiber = yield* ask({
        id: PermissionV1.ID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      }).pipe(Effect.forkScoped)

      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      yield* store.reload({ directory: test.directory })

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  { git: true },
)
