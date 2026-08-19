import { expect, test } from "bun:test"
import { serialiseReviewInput } from "@/permission/reviewer-input"

function data(permission: string, arguments_: unknown, origin = "tool") {
  const result = serialiseReviewInput({ permission, origin, arguments: arguments_ })
  expect("data" in result).toBe(true)
  if (!("data" in result)) throw new Error(`input was rejected: ${result.failure}`)
  expect(Buffer.byteLength(result.data, "utf8")).toBeLessThanOrEqual(16 * 1024)
  return { raw: result.data, value: JSON.parse(result.data), automaticAllow: result.automaticAllow }
}

test("shell facts preserve risks without commands, paths, URLs, headers, environment values, or positional secrets", () => {
  const secrets = [
    "TOP_SECRET_VALUE",
    "positional-password",
    "/home/alice/private/key.pem",
    "internal.example/private?token=query-secret",
    "Bearer bearer-secret",
  ]
  const command = [
    `API_TOKEN=${secrets[0]}`,
    "curl",
    `-H 'Authorization: ${secrets[4]}'`,
    "--password positional-password",
    `https://${secrets[2]}@${secrets[3]}`,
    secrets[2],
    "| sudo sh -c 'base64 -d > /etc/secret'",
  ].join(" ")
  const result = data("bash", { command, timeout: 1_000, workdir: "/home/alice/private" })
  expect(result.automaticAllow).toBe(false)
  for (const secret of secrets) expect(result.raw).not.toContain(secret)
  expect(result.raw).not.toContain("alice")
  expect(result.value.operation).toMatchObject({
    kind: "shell",
    commands: ["curl", "sudo"],
    timeoutConfigured: true,
    workdir: { scope: "home" },
  })
  expect(result.value.operation.traits).toEqual(
    expect.arrayContaining([
      "absolute-path",
      "credential-option",
      "credential-value",
      "dynamic-execution",
      "encoded-payload",
      "environment-assignment",
      "header",
      "network",
      "privilege",
      "redirection",
      "url-query",
    ]),
  )
})

test("shell classification scans the dangerous suffix instead of truncating it", () => {
  const prefix = "printf safe;".repeat(12_000)
  const result = data("bash", { command: `${prefix} rm -rf /` })
  expect(result.value.operation.commands).toContain("rm")
  expect(result.value.operation.traits).toContain("destructive")
  expect(result.value.operation.commandCount).toBe("many")
})

test("shell classification handles quoted delimiters and ordinary control flow", () => {
  const pipeline = data("bash", {
    command:
      "find /home/opencode/.local/share/planefolio -maxdepth 5 \\( -type f -o -type d \\) -printf '%y %p\\n' 2>/dev/null | grep -E '(deploy|journal|intent|lock|pending)' | sort",
    workdir: "/mnt/crypt/home/syncthing/Development/planefolio",
  })
  expect(pipeline.value.operation).toMatchObject({
    kind: "shell",
    commands: ["find", "grep", "sort"],
    commandCount: 3,
  })

  const loop = data("bash", {
    command:
      'for p in /tmp/one /tmp/two; do if [ -e "$p" ]; then stat -c \'PRESENT %n\' "$p"; else printf \'ABSENT %s\\n\' "$p"; fi; done',
    workdir: "/tmp",
  })
  expect(loop.value.operation).toMatchObject({
    kind: "shell",
    commands: ["[", "printf", "stat"],
    commandCount: "many",
  })
  expect(loop.value.operation.traits).toEqual(
    expect.arrayContaining(["absolute-path", "control-flow", "interpolation"]),
  )
})

test("complex shell execution is represented conservatively", () => {
  for (const command of [
    'case x in x) "rm" -rf relative-target;; esac',
    "env custom-secret-runner positional-secret",
    '"env" custom-secret-runner positional-secret',
    "/usr/bin/env custom-secret-runner positional-secret",
    "xargs custom-secret-runner",
    '"xargs" custom-secret-runner',
    "/usr/bin/xargs custom-secret-runner",
    "sudo env custom-secret-runner positional-secret",
    "sudo /usr/bin/xargs custom-secret-runner",
    'echo "$(custom-one; custom-two; custom-three)"',
    "cat <(custom-secret-runner positional-secret)",
  ]) {
    const result = data("bash", { command })
    expect(result.raw).not.toContain("custom-secret-runner")
    expect(result.raw).not.toContain("positional-secret")
    expect(result.raw).not.toContain("custom-one")
    expect(result.value.operation.traits).toContain("unknown-command")
  }

  const case_ = data("bash", { command: 'case x in x) "rm" -rf relative-target;; esac' })
  expect(case_.value.operation).toMatchObject({ commandCount: "many" })
  expect(case_.value.operation.traits).toEqual(
    expect.arrayContaining(["control-flow", "destructive", "unknown-command"]),
  )

  const nested = data("bash", { command: 'echo "$(custom-one; custom-two; custom-three)"' })
  expect(nested.value.operation).toMatchObject({ commandCount: "many", commands: ["echo"] })
  expect(nested.value.operation.traits).toEqual(
    expect.arrayContaining(["dynamic-execution", "interpolation", "unknown-command"]),
  )

  const process = data("bash", { command: "cat <(custom-secret-runner positional-secret)" })
  expect(process.value.operation).toMatchObject({ commandCount: "many", commands: ["cat"] })
  expect(process.value.operation.traits).toEqual(
    expect.arrayContaining(["dynamic-execution", "redirection", "unknown-command"]),
  )
})

test("shell comments and ANSI-C strings do not confuse quote tracking", () => {
  expect(data("bash", { command: 'printf ok # unmatched "' }).value.operation.commands).toEqual(["printf"])
  expect(data("bash", { command: "printf $'can\\'t'" }).value.operation.commands).toEqual(["printf"])
})

test("path and URL facts are non-reversible but risk-preserving", () => {
  const path = "/home/alice/.ssh/id_ed25519"
  const read = data("read", { filePath: path, offset: 1, limit: 20 })
  expect(read.automaticAllow).toBe(false)
  expect(read.raw).not.toContain(path)
  expect(read.raw).not.toContain("alice")
  expect(read.value.operation).toMatchObject({
    kind: "read",
    ranged: true,
    target: { scope: "home", hidden: true, type: "none" },
  })

  const url = "https://user:password@private.example/secret/customer/42?api_key=value#token"
  const fetch = data("webfetch", { url, format: "text", timeout: 5 })
  expect(fetch.raw).not.toContain("private.example")
  expect(fetch.raw).not.toContain("customer")
  expect(fetch.raw).not.toContain("password")
  expect(fetch.value.operation).toMatchObject({
    kind: "webfetch",
    host: "public-name",
    embeddedUserInfo: true,
    query: true,
    fragment: true,
    format: "text",
  })
})

test("no shell execution context can turn a model allow into an enforcing allow", () => {
  for (const arguments_ of [
    { command: "git status", workdir: "/tmp/attacker-controlled" },
    { command: "PATH=/tmp/bin GIT_CONFIG=/tmp/config git status" },
    { command: "git -c core.hooksPath=/tmp/hooks status" },
    { command: "git -C /tmp/repository status" },
    { command: "git --config-env=credential.helper=HELPER status" },
    { command: '"git" status' },
    { command: "git status && printf done" },
    { command: "git status $(bash -c 'printf attack')" },
    { command: "git status > /tmp/result" },
    { command: "git show attacker-revision -- private/path" },
  ]) {
    expect(data("bash", arguments_).automaticAllow).toBe(false)
  }
})

test("every classified non-shell permission explicitly disables enforcing allow", () => {
  const operations: ReadonlyArray<readonly [string, unknown, string?]> = [
    ["read", { filePath: "relative/file.ts" }],
    ["glob", { pattern: "**/*.ts", path: "src" }],
    ["grep", { pattern: "token", path: "src", include: "*.ts" }],
    ["webfetch", { url: "https://example.test/path" }],
    ["websearch", { query: "public documentation" }],
    ["lsp", { operation: "hover", filePath: "src/a.ts", line: 1, character: 1 }],
    ["skill", { name: "example" }],
    ["external_directory", { filePath: "../outside" }],
    ["doom_loop", { command: "git status" }, "doom_loop"],
  ]
  for (const [permission, arguments_, origin] of operations) {
    expect(data(permission, arguments_, origin).automaticAllow).toBe(false)
  }
})

test("search and LSP inputs expose bounded structure rather than raw terms or paths", () => {
  const query = "find token customer-secret at https://private.example/path?key=value"
  const search = data("websearch", { query, numResults: 5, livecrawl: "preferred", type: "deep" })
  expect(search.raw).not.toContain("customer-secret")
  expect(search.raw).not.toContain("private.example")
  expect(search.value.operation).toMatchObject({ kind: "websearch", live: true, depth: "deep" })
  expect(search.value.operation.queryTraits).toEqual(expect.arrayContaining(["url", "credential-term"]))

  const filePath = "/srv/private/project/src/secret.ts"
  const lsp = data("lsp", { operation: "hover", filePath, line: 10, character: 2, query: "privateSymbol" })
  expect(lsp.raw).not.toContain(filePath)
  expect(lsp.raw).not.toContain("privateSymbol")
  expect(lsp.value.operation).toMatchObject({ kind: "lsp", operation: "hover", queryConfigured: true })
})

test("unknown, oversized, accessor, proxy, and cyclic argument shapes fail before serialisation", () => {
  expect(serialiseReviewInput({ permission: "custom", origin: "tool", arguments: {} })).toEqual({ failure: "input" })
  expect(
    serialiseReviewInput({
      permission: "bash",
      origin: "tool",
      arguments: { command: "git status", unexpected: "secret" },
    }),
  ).toEqual({ failure: "input" })
  const unknown = data("bash", { command: "custom-secret-runner positional-secret" })
  expect(unknown.raw).not.toContain("custom-secret-runner")
  expect(unknown.raw).not.toContain("positional-secret")
  expect(unknown.value.operation).toMatchObject({ commands: [], traits: ["unknown-command"] })
  expect(
    serialiseReviewInput({
      permission: "bash",
      origin: "tool",
      arguments: { command: "x".repeat(256 * 1024 + 1) },
    }),
  ).toEqual({ failure: "input" })

  const accessor = Object.create(null)
  Object.defineProperty(accessor, "command", { enumerable: true, get: () => "rm -rf /" })
  expect(serialiseReviewInput({ permission: "bash", origin: "tool", arguments: accessor })).toEqual({
    failure: "input",
  })

  const proxy = new Proxy({ command: "git status" }, {})
  expect(serialiseReviewInput({ permission: "bash", origin: "tool", arguments: proxy })).toEqual({ failure: "input" })

  const cyclic: Record<string, unknown> = { command: "git status" }
  cyclic.self = cyclic
  expect(serialiseReviewInput({ permission: "bash", origin: "tool", arguments: cyclic })).toEqual({ failure: "input" })
})

test("content-bearing and ambiguous built-in operations fail closed", () => {
  for (const [permission, arguments_] of [
    ["edit", { filePath: "/tmp/file", oldString: "safe", newString: "dangerous" }],
    ["todowrite", { todos: [] }],
    ["task", { description: "work", prompt: "secret", subagent_type: "general" }],
    ["external_directory", { filePath: "/tmp/file", content: "secret" }],
  ] as const) {
    expect(serialiseReviewInput({ permission, origin: "tool", arguments: arguments_ })).toEqual({ failure: "input" })
  }
})
