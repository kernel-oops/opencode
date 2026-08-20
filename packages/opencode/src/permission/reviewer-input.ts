import type { PermissionReviewValue } from "@opencode-ai/plugin"
import { types } from "node:util"
import { safeReviewValue } from "./review"

const MAX_DTO_BYTES = 16 * 1024
const MAX_RAW_BYTES = 256 * 1024

type Failure = "input" | "lossy" | "serialization" | "size"

type PathFacts = {
  scope: "relative" | "parent" | "root" | "system" | "home" | "temporary" | "device" | "network"
  depth: "root" | "shallow" | "deep" | "very-deep"
  hidden: boolean
  wildcard: boolean
  type: "none" | "code" | "config" | "secret" | "executable" | "archive" | "data" | "other"
}

type Facts = {
  permission: string
  origin: "tool" | "doom_loop" | "unknown"
  operation: PermissionReviewValue
}

type RecordResult = { value: Record<string, unknown> } | { failure: Failure }
type Serialised = { data: string; automaticAllow: boolean } | { failure: Failure }

const supported = new Set([
  "bash",
  "external_directory",
  "glob",
  "grep",
  "lsp",
  "read",
  "skill",
  "webfetch",
  "websearch",
  "doom_loop",
])

const knownCommands = new Set([
  "[",
  "apt",
  "apt-get",
  "basename",
  "bash",
  "bun",
  "cat",
  "chmod",
  "chown",
  "cmd",
  "cp",
  "curl",
  "dd",
  "dnf",
  "docker",
  "echo",
  "env",
  "find",
  "git",
  "gh",
  "grep",
  "head",
  "id",
  "jq",
  "kill",
  "ln",
  "ls",
  "make",
  "mkdir",
  "mv",
  "npm",
  "npx",
  "perl",
  "pip",
  "pip3",
  "pnpm",
  "powershell",
  "printf",
  "pwsh",
  "python",
  "python3",
  "pwd",
  "readlink",
  "rm",
  "rmdir",
  "rsync",
  "scp",
  "sed",
  "sh",
  "ssh",
  "sort",
  "stat",
  "sudo",
  "systemctl",
  "tail",
  "tar",
  "tee",
  "test",
  "tr",
  "true",
  "uname",
  "wc",
  "wget",
  "which",
  "xargs",
  "yarn",
  "yum",
])

function shellSegments(command: string) {
  const segments: string[] = []
  let current = ""
  let quote: "'" | '"' | "ansi" | undefined
  let escaped = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\" && quote !== "'") {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if ((quote === "ansi" && character === "'") || character === quote) quote = undefined
      continue
    }
    if (character === "$" && command[index + 1] === "'") {
      quote = "ansi"
      current += "$'"
      index++
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      current += character
      continue
    }
    if (character === "#" && (index === 0 || /[\s;&|]/.test(command[index - 1]))) {
      while (index + 1 < command.length && command[index + 1] !== "\n" && command[index + 1] !== "\r") index++
      continue
    }
    const pair = command.slice(index, index + 2)
    if (pair === "&&" || pair === "||") index++
    else if (character !== ";" && character !== "|" && character !== "&" && character !== "\n" && character !== "\r") {
      current += character
      continue
    }
    if (current.trim()) segments.push(current)
    current = ""
  }
  if (escaped || quote) return
  if (current.trim()) segments.push(current)
  return segments
}

function shellCommand(segment: string) {
  const words = segment.trim().split(/\s+/)
  let index = 0
  while (index < words.length) {
    const word = words[index].toLowerCase()
    if (["for", "select", "case", "function", "fi", "done", "esac"].includes(word)) return
    if (["!", "do", "then", "else", "elif", "if", "while", "until"].includes(word)) {
      index++
      continue
    }
    if (/^[a-z_][a-z0-9_]*=/i.test(words[index])) {
      index++
      continue
    }
    return words[index]
  }
}

function shellName(word: string) {
  return (
    word
      .replace(/^['"]|['"]$/g, "")
      .replaceAll("\\", "/")
      .split("/")
      .pop()
      ?.toLowerCase() ?? ""
  )
}

function record(input: unknown, allowed: readonly string[], required: readonly string[]): RecordResult {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)) return { failure: "input" }
  try {
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return { failure: "input" }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) return { failure: "input" }
    if (required.some((key) => !keys.includes(key))) return { failure: "input" }
    const value: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      if (typeof key !== "string") return { failure: "input" }
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return { failure: "input" }
      value[key] = descriptor.value
    }
    return { value }
  } catch {
    return { failure: "input" }
  }
}

function bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

function length(value: string) {
  const size = bytes(value)
  if (size === 0) return "empty" as const
  if (size <= 64) return "short" as const
  if (size <= 1_024) return "medium" as const
  if (size <= 16_384) return "long" as const
  return "very-long" as const
}

function extension(value: string): PathFacts["type"] {
  const match = value.toLowerCase().match(/\.([a-z0-9]{1,12})$/)
  const item = match?.[1]
  if (!item) return "none"
  if (
    [
      "c",
      "cc",
      "cpp",
      "css",
      "go",
      "h",
      "html",
      "java",
      "js",
      "json",
      "jsx",
      "md",
      "py",
      "rs",
      "sh",
      "ts",
      "tsx",
    ].includes(item)
  )
    return "code"
  if (["cfg", "conf", "env", "ini", "toml", "yaml", "yml"].includes(item)) return "config"
  if (["crt", "key", "pem", "p12", "pfx"].includes(item)) return "secret"
  if (["app", "bat", "bin", "cmd", "com", "exe", "msi", "ps1"].includes(item)) return "executable"
  if (["7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip"].includes(item)) return "archive"
  if (["csv", "db", "sqlite", "sql", "xml"].includes(item)) return "data"
  return "other"
}

function pathFacts(value: unknown): PathFacts | undefined {
  if (typeof value !== "string" || bytes(value) > MAX_RAW_BYTES || value.includes("\0")) return
  const normalized = value.replaceAll("\\", "/")
  const lower = normalized.toLowerCase()
  const absolute = normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)
  const segments = normalized.split("/").filter(Boolean)
  let scope: PathFacts["scope"] = "relative"
  if (normalized.startsWith("//")) scope = "network"
  else if (normalized === "/" || /^[a-z]:\/?$/i.test(normalized)) scope = "root"
  else if (/^(?:[a-z]:)?\/(?:dev|proc|sys)(?:\/|$)/i.test(normalized)) scope = "device"
  else if (/^(?:[a-z]:)?\/(?:etc|boot|usr|var|windows|program files)(?:\/|$)/i.test(normalized)) scope = "system"
  else if (normalized.startsWith("~/") || /^(?:[a-z]:)?\/(?:home|users)(?:\/|$)/i.test(normalized)) scope = "home"
  else if (/^(?:[a-z]:)?\/(?:tmp|temp)(?:\/|$)/i.test(normalized)) scope = "temporary"
  else if (segments.includes("..")) scope = "parent"
  else if (absolute) scope = "root"

  return {
    scope,
    depth:
      segments.length === 0 ? "root" : segments.length <= 2 ? "shallow" : segments.length <= 8 ? "deep" : "very-deep",
    hidden: segments.some((item) => item.startsWith(".") && item !== "." && item !== ".."),
    wildcard: /[*?[]/.test(value),
    type: extension(lower),
  }
}

function shell(input: unknown): PermissionReviewValue | undefined {
  const parsed = record(input, ["command", "timeout", "workdir"], ["command"])
  if ("failure" in parsed) return
  const command = parsed.value.command
  const timeout = parsed.value.timeout
  if (typeof command !== "string" || bytes(command) > MAX_RAW_BYTES) return
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) return
  const workdir = parsed.value.workdir === undefined ? undefined : pathFacts(parsed.value.workdir)
  if (parsed.value.workdir !== undefined && !workdir) return

  const lower = command.toLowerCase()
  const segments = shellSegments(command)
  if (!segments) return
  const names = new Set<string>()
  let executableCount = 0
  const controlFlow = /(^|[;&|\s])(for|select|case|if|while|until|function)(?=$|\s)/i.test(command)
  const nestedExecution = /\$\(|`|[<>]\(/.test(command)
  let delegatedExecution = false
  let unknownCommand = /(^|[;&|\s])(case|select|function)(?=$|\s)/i.test(command) || nestedExecution
  for (const segment of segments) {
    if (
      segment
        .trim()
        .split(/\s+/)
        .some((word) => ["env", "xargs"].includes(shellName(word)))
    ) {
      delegatedExecution = true
      unknownCommand = true
    }
    let first = shellCommand(segment)
    if (!first) continue
    executableCount++
    const name = shellName(first)
    if (knownCommands.has(name)) {
      names.add(name)
    } else unknownCommand = true
  }

  const traits = new Set<string>()
  if (unknownCommand) traits.add("unknown-command")
  if (controlFlow) traits.add("control-flow")
  if (/(^|[;&|\s(])['"]?(rm|rmdir|del|erase|remove-item|dd|mkfs)['"]?(?=$|\s)/i.test(command)) traits.add("destructive")
  if (/\b(git\s+(push|reset|clean|rebase)|npm\s+publish|cargo\s+publish|docker\s+(push|rm|rmi))\b/i.test(command))
    traits.add("remote-or-state-write")
  if (/(^|\s)(sudo|su|doas)(?=$|\s)/i.test(command)) traits.add("privilege")
  if (/\b(chmod|chown|setfacl|icacls)\b/i.test(command)) traits.add("permission-change")
  if (/\b(curl|wget|ssh|scp|rsync|nc|netcat|telnet)\b/i.test(command) || /https?:\/\//i.test(command))
    traits.add("network")
  if (/(^|\s)(?:export\s+)?[a-z_][a-z0-9_]*=/i.test(command)) traits.add("environment-assignment")
  if (/(^|\s)(-h|--header)(?:=|\s)|\b(authorization|proxy-authorization|cookie|set-cookie)\s*:/i.test(command))
    traits.add("header")
  if (/(^|\s)--?(password|passphrase|secret|token|api[-_]?key|credential|private[-_]?key)(?:=|\s|$)/i.test(command))
    traits.add("credential-option")
  if (/\b(bearer|basic)\s+[a-z0-9+/_=.-]+/i.test(command)) traits.add("credential-value")
  if (
    /(^|\s)(eval|exec)(?=$|\s)|\b(sh|bash|python|perl)\s+-c\b/i.test(command) ||
    nestedExecution ||
    delegatedExecution
  )
    traits.add("dynamic-execution")
  if (/\$\(|`|\$\{|\$[a-z_]/i.test(command)) traits.add("interpolation")
  if (/(^|[^<])(?:>>?|<<?)(?![<])/m.test(command)) traits.add("redirection")
  if (/(^|[\s'"=])(?:\/[^\s'";|]+|[a-z]:[\\/][^\s'";|]+)/i.test(command)) traits.add("absolute-path")
  if (/(^|[\s'"=])~[\\/]/.test(command)) traits.add("home-path")
  if (/[?&][^\s=]+=/i.test(command)) traits.add("url-query")
  if (/\b(base64|xxd|openssl\s+enc)\b/i.test(command)) traits.add("encoded-payload")

  return {
    kind: "shell",
    size: length(command),
    commandCount: controlFlow || nestedExecution || executableCount > 10 ? "many" : executableCount,
    commands: [...names].sort(),
    traits: [...traits].sort(),
    timeoutConfigured: timeout !== undefined,
    ...(workdir ? { workdir } : {}),
  }
}

function read(input: unknown): PermissionReviewValue | undefined {
  const parsed = record(input, ["filePath", "offset", "limit"], ["filePath"])
  if ("failure" in parsed) return
  const target = pathFacts(parsed.value.filePath)
  if (!target) return
  for (const key of ["offset", "limit"] as const) {
    const item = parsed.value[key]
    if (item !== undefined && (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) return
  }
  return { kind: "read", target, ranged: parsed.value.offset !== undefined || parsed.value.limit !== undefined }
}

function pattern(input: unknown, permission: "glob" | "grep"): PermissionReviewValue | undefined {
  const allowed = permission === "glob" ? ["pattern", "path"] : ["pattern", "path", "include"]
  const parsed = record(input, allowed, ["pattern"])
  if ("failure" in parsed || typeof parsed.value.pattern !== "string" || bytes(parsed.value.pattern) > MAX_RAW_BYTES)
    return
  const target = parsed.value.path === undefined ? undefined : pathFacts(parsed.value.path)
  if (parsed.value.path !== undefined && !target) return
  if (
    parsed.value.include !== undefined &&
    (typeof parsed.value.include !== "string" || bytes(parsed.value.include) > MAX_RAW_BYTES)
  )
    return
  return {
    kind: permission,
    patternSize: length(parsed.value.pattern),
    patternTraits: [
      ...(/[*?[]/.test(parsed.value.pattern) ? ["wildcard"] : []),
      ...(/\.\*|\.\+|\[[^\]]*\]|\([^)]*\)/.test(parsed.value.pattern) ? ["complex"] : []),
      ...(parsed.value.pattern.startsWith("^") || parsed.value.pattern.endsWith("$") ? ["anchored"] : []),
    ],
    includeConfigured: parsed.value.include !== undefined,
    ...(target ? { target } : {}),
  }
}

function webfetch(input: unknown): PermissionReviewValue | undefined {
  const parsed = record(input, ["url", "format", "timeout"], ["url"])
  if ("failure" in parsed || typeof parsed.value.url !== "string" || bytes(parsed.value.url) > MAX_RAW_BYTES) return
  const format = parsed.value.format
  if (format !== undefined && (typeof format !== "string" || !["text", "markdown", "html"].includes(format))) return
  if (
    parsed.value.timeout !== undefined &&
    (typeof parsed.value.timeout !== "number" || !Number.isFinite(parsed.value.timeout) || parsed.value.timeout <= 0)
  )
    return
  try {
    const url = new URL(parsed.value.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    const host = url.hostname.toLowerCase()
    const hostType =
      host === "localhost" || host.endsWith(".localhost")
        ? "local"
        : /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
          ? "private"
          : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")
            ? "public-address"
            : host.endsWith(".onion")
              ? "onion"
              : "public-name"
    return {
      kind: "webfetch",
      scheme: url.protocol.slice(0, -1),
      host: hostType,
      embeddedUserInfo: Boolean(url.username || url.password),
      nonDefaultPort: Boolean(
        url.port &&
          !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")),
      ),
      pathDepth: url.pathname.split("/").filter(Boolean).length <= 3 ? "shallow" : "deep",
      query: Boolean(url.search),
      fragment: Boolean(url.hash),
      format: format ?? "markdown",
      timeoutConfigured: parsed.value.timeout !== undefined,
    }
  } catch {
    return
  }
}

function websearch(input: unknown): PermissionReviewValue | undefined {
  const parsed = record(input, ["query", "numResults", "livecrawl", "type", "contextMaxCharacters"], ["query"])
  if ("failure" in parsed || typeof parsed.value.query !== "string" || bytes(parsed.value.query) > MAX_RAW_BYTES) return
  if (
    parsed.value.numResults !== undefined &&
    (typeof parsed.value.numResults !== "number" || !Number.isFinite(parsed.value.numResults))
  )
    return
  if (
    parsed.value.contextMaxCharacters !== undefined &&
    (typeof parsed.value.contextMaxCharacters !== "number" || !Number.isFinite(parsed.value.contextMaxCharacters))
  )
    return
  const livecrawl = parsed.value.livecrawl
  const type = parsed.value.type
  if (livecrawl !== undefined && (typeof livecrawl !== "string" || !["fallback", "preferred"].includes(livecrawl)))
    return
  if (type !== undefined && (typeof type !== "string" || !["auto", "fast", "deep"].includes(type))) return
  return {
    kind: "websearch",
    querySize: length(parsed.value.query),
    queryTraits: [
      ...(/https?:\/\//i.test(parsed.value.query) ? ["url"] : []),
      ...(/\b(password|passphrase|secret|token|api[-_]?key|credential)\b/i.test(parsed.value.query)
        ? ["credential-term"]
        : []),
    ],
    resultCountConfigured: parsed.value.numResults !== undefined,
    live: livecrawl === "preferred",
    depth: type ?? "auto",
  }
}

function lsp(input: unknown): PermissionReviewValue | undefined {
  const parsed = record(
    input,
    ["operation", "filePath", "line", "character", "query"],
    ["operation", "filePath", "line", "character"],
  )
  if ("failure" in parsed || typeof parsed.value.operation !== "string") return
  const operations = [
    "goToDefinition",
    "findReferences",
    "hover",
    "documentSymbol",
    "workspaceSymbol",
    "goToImplementation",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
  ]
  if (!operations.includes(parsed.value.operation)) return
  const target = pathFacts(parsed.value.filePath)
  if (!target) return
  if (!Number.isSafeInteger(parsed.value.line) || !Number.isSafeInteger(parsed.value.character)) return
  if (
    parsed.value.query !== undefined &&
    (typeof parsed.value.query !== "string" || bytes(parsed.value.query) > MAX_RAW_BYTES)
  )
    return
  return { kind: "lsp", operation: parsed.value.operation, target, queryConfigured: parsed.value.query !== undefined }
}

function skill(input: unknown): PermissionReviewValue | undefined {
  const parsed = record(input, ["name"], ["name"])
  if ("failure" in parsed || typeof parsed.value.name !== "string" || bytes(parsed.value.name) > MAX_RAW_BYTES) return
  return { kind: "skill", nameSize: length(parsed.value.name) }
}

function classify(permission: string, input: unknown): PermissionReviewValue | undefined {
  if (permission === "bash") return shell(input)
  if (permission === "read") return read(input)
  if (permission === "glob" || permission === "grep") return pattern(input, permission)
  if (permission === "webfetch") return webfetch(input)
  if (permission === "websearch") return websearch(input)
  if (permission === "lsp") return lsp(input)
  if (permission === "skill") return skill(input)
  if (permission === "external_directory" || permission === "doom_loop") {
    return (
      shell(input) ?? read(input) ?? pattern(input, "glob") ?? pattern(input, "grep") ?? webfetch(input) ?? lsp(input)
    )
  }
}

function canonical(value: PermissionReviewValue): PermissionReviewValue {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

export function serialiseReviewInput(input: { permission: string; origin: string; arguments?: unknown }): Serialised {
  if (!supported.has(input.permission)) return { failure: "input" }
  if (input.origin !== "tool" && input.origin !== "doom_loop" && input.origin !== "unknown") return { failure: "input" }
  const operation = classify(input.permission, input.arguments)
  if (!operation) return { failure: "input" }
  const facts: Facts = { permission: input.permission, origin: input.origin, operation }
  const safe = safeReviewValue(facts)
  try {
    const original = JSON.stringify(canonical(facts))
    const data = JSON.stringify(safe)
    if (original !== data) return { failure: "lossy" }
    if (bytes(data) > MAX_DTO_BYTES) return { failure: "size" }
    // Every current classifier deliberately removes a security-relevant target, execution
    // context, or operation detail. Luna may therefore deny or advise in audit mode, but its
    // allow can never safely become an automatic enforcing allow.
    return { data, automaticAllow: false }
  } catch {
    return { failure: "serialization" }
  }
}
