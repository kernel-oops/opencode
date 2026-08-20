import { createOpenAI } from "@ai-sdk/openai"
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { extractResidency } from "@/plugin/openai/codex"

// /home is a symlink on the central host. Pin the canonical backing path so
// every component can be opened with O_NOFOLLOW.
export const REPLAY_AUTH_FILE = "/mnt/crypt/home/opencode/.local/share/opencode/auth.json"
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/responses`
export const REPLAY_API_MODEL = "gpt-5.6-luna"
const MAX_AUTH_BYTES = 1024 * 1024
const EXPIRY_SAFETY_MS = 30_000
const DUMMY_KEY = "opencode-oauth-dummy-key"
const O_DIRECTORY = 0o200000
const O_CLOEXEC = 0o2000000

export type ReplayOAuth = Readonly<{ access: string; expires: number; accountId?: string }>
export type ReplayAuthResult = { auth: ReplayOAuth } | { failure: "auth" | "auth_expired" }
export type ReplayNetworkFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

class JsonCursor {
  private offset = 0
  private readonly decoder = new TextDecoder("utf-8", { fatal: true })

  constructor(private readonly data: Buffer) {}

  private whitespace() {
    while ([0x20, 0x09, 0x0a, 0x0d].includes(this.data[this.offset] ?? -1)) this.offset++
  }

  private byte(expected: number) {
    this.whitespace()
    if (this.data[this.offset++] !== expected) throw new Error("invalid auth JSON")
  }

  private string(decode: boolean): string | undefined {
    this.whitespace()
    const start = this.offset
    if (this.data[this.offset++] !== 0x22) throw new Error("invalid auth JSON")
    while (this.offset < this.data.length) {
      const value = this.data[this.offset++]!
      if (value === 0x22) {
        if (!decode) return
        const text = this.decoder.decode(this.data.subarray(start, this.offset))
        const result = JSON.parse(text) as unknown
        if (typeof result !== "string") throw new Error("invalid auth JSON")
        return result
      }
      if (value < 0x20) throw new Error("invalid auth JSON")
      if (value !== 0x5c) continue
      const escaped = this.data[this.offset++]
      if (escaped === 0x75) {
        for (let index = 0; index < 4; index++) {
          const hex = this.data[this.offset++]
          if (
            hex === undefined ||
            !((hex >= 0x30 && hex <= 0x39) || (hex >= 0x41 && hex <= 0x46) || (hex >= 0x61 && hex <= 0x66))
          )
            throw new Error("invalid auth JSON")
        }
      } else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escaped ?? -1)) {
        throw new Error("invalid auth JSON")
      }
    }
    throw new Error("invalid auth JSON")
  }

  private number(): number {
    this.whitespace()
    const start = this.offset
    if (this.data[this.offset] === 0x2d) this.offset++
    if (this.data[this.offset] === 0x30) {
      this.offset++
    } else {
      if ((this.data[this.offset] ?? -1) < 0x31 || (this.data[this.offset] ?? -1) > 0x39)
        throw new Error("invalid auth JSON")
      while ((this.data[this.offset] ?? -1) >= 0x30 && (this.data[this.offset] ?? -1) <= 0x39) this.offset++
    }
    if (this.data[this.offset] === 0x2e) {
      this.offset++
      const fraction = this.offset
      while ((this.data[this.offset] ?? -1) >= 0x30 && (this.data[this.offset] ?? -1) <= 0x39) this.offset++
      if (this.offset === fraction) throw new Error("invalid auth JSON")
    }
    if (this.data[this.offset] === 0x65 || this.data[this.offset] === 0x45) {
      this.offset++
      if (this.data[this.offset] === 0x2b || this.data[this.offset] === 0x2d) this.offset++
      const exponent = this.offset
      while ((this.data[this.offset] ?? -1) >= 0x30 && (this.data[this.offset] ?? -1) <= 0x39) this.offset++
      if (this.offset === exponent) throw new Error("invalid auth JSON")
    }
    const value = Number(this.data.subarray(start, this.offset).toString("ascii"))
    if (!Number.isFinite(value)) throw new Error("invalid auth JSON")
    return value
  }

  private literal(value: string) {
    for (const byte of Buffer.from(value, "ascii"))
      if (this.data[this.offset++] !== byte) throw new Error("invalid auth JSON")
  }

  private skip(depth = 0): void {
    if (depth > 64) throw new Error("invalid auth JSON")
    this.whitespace()
    const value = this.data[this.offset]
    if (value === 0x22) return void this.string(false)
    if (value === 0x7b) {
      this.offset++
      this.whitespace()
      if (this.data[this.offset] === 0x7d) return void this.offset++
      while (true) {
        this.string(false)
        this.byte(0x3a)
        this.skip(depth + 1)
        this.whitespace()
        if (this.data[this.offset++] === 0x7d) return
        if (this.data[this.offset - 1] !== 0x2c) throw new Error("invalid auth JSON")
      }
    }
    if (value === 0x5b) {
      this.offset++
      this.whitespace()
      if (this.data[this.offset] === 0x5d) return void this.offset++
      while (true) {
        this.skip(depth + 1)
        this.whitespace()
        if (this.data[this.offset++] === 0x5d) return
        if (this.data[this.offset - 1] !== 0x2c) throw new Error("invalid auth JSON")
      }
    }
    if (value === 0x74) return this.literal("true")
    if (value === 0x66) return this.literal("false")
    if (value === 0x6e) return this.literal("null")
    this.number()
  }

  private openAI(): Record<string, string | number | undefined> {
    const result: Record<string, string | number | undefined> = {}
    const seen = new Set<string>()
    this.byte(0x7b)
    this.whitespace()
    if (this.data[this.offset] === 0x7d) {
      this.offset++
      return result
    }
    while (true) {
      const key = this.string(true)!
      this.byte(0x3a)
      if (["type", "access", "expires", "accountId"].includes(key)) {
        if (seen.has(key)) throw new Error("invalid auth JSON")
        seen.add(key)
        result[key] = key === "expires" ? this.number() : this.string(true)
      } else {
        this.skip()
      }
      this.whitespace()
      if (this.data[this.offset++] === 0x7d) return result
      if (this.data[this.offset - 1] !== 0x2c) throw new Error("invalid auth JSON")
    }
  }

  extractOpenAI(): Record<string, string | number | undefined> {
    let result: Record<string, string | number | undefined> | undefined
    this.byte(0x7b)
    this.whitespace()
    if (this.data[this.offset] !== 0x7d) {
      while (true) {
        const key = this.string(true)!
        this.byte(0x3a)
        if (key === "openai") {
          if (result) throw new Error("invalid auth JSON")
          result = this.openAI()
        } else {
          this.skip()
        }
        this.whitespace()
        if (this.data[this.offset++] === 0x7d) break
        if (this.data[this.offset - 1] !== 0x2c) throw new Error("invalid auth JSON")
      }
    } else {
      this.offset++
    }
    this.whitespace()
    if (this.offset !== this.data.length || !result) throw new Error("invalid auth JSON")
    return result
  }
}

function openNoFollow(path: string) {
  if (!path.startsWith("/") || path.includes("\0")) throw new Error("invalid auth path")
  const parts = path.split("/").filter(Boolean)
  if (parts.length === 0) throw new Error("invalid auth path")
  let directory = openSync("/", constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC)
  try {
    for (const part of parts.slice(0, -1)) {
      if (part === "." || part === "..") throw new Error("invalid auth path")
      const next = openSync(
        `/proc/self/fd/${directory}/${part}`,
        constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC,
      )
      closeSync(directory)
      directory = next
    }
    return openSync(`/proc/self/fd/${directory}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC)
  } finally {
    closeSync(directory)
  }
}

export function loadReplayOAuth(path = REPLAY_AUTH_FILE, now = Date.now()): ReplayAuthResult {
  let fd = -1
  let buffer: Buffer | undefined
  try {
    fd = openNoFollow(path)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_AUTH_BYTES) return { failure: "auth" }
    if ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()))
      return { failure: "auth" }
    buffer = Buffer.allocUnsafe(info.size + 1)
    let offset = 0
    while (offset < info.size) {
      const size = readSync(fd, buffer, offset, info.size - offset, offset)
      if (size <= 0) return { failure: "auth" }
      offset += size
    }
    if (readSync(fd, buffer, info.size, 1, info.size) !== 0) return { failure: "auth" }
    // Parse only the selected OpenAI fields. Unknown provider values and the
    // OAuth refresh value are validated and skipped without decoding them.
    const value = new JsonCursor(buffer.subarray(0, info.size)).extractOpenAI()
    if (value.type !== "oauth" || typeof value.access !== "string" || !value.access) return { failure: "auth" }
    if (!Number.isSafeInteger(value.expires) || (value.expires as number) <= now + EXPIRY_SAFETY_MS)
      return { failure: "auth_expired" }
    if (value.accountId !== undefined && (typeof value.accountId !== "string" || !value.accountId))
      return { failure: "auth" }
    return {
      auth: {
        access: value.access,
        expires: value.expires as number,
        ...(typeof value.accountId === "string" ? { accountId: value.accountId } : {}),
      },
    }
  } catch {
    return { failure: "auth" }
  } finally {
    if (buffer) buffer.fill(0)
    if (fd >= 0) closeSync(fd)
  }
}

export function createReplayCodexFetch(
  auth: ReplayOAuth,
  networkFetch: ReplayNetworkFetch = fetch,
): ReplayNetworkFetch {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
    if (url.href !== CODEX_RESPONSES_URL || init?.method !== "POST")
      throw new Error("permission replay blocked an unexpected network destination")
    const headers = new Headers(init.headers)
    headers.delete("authorization")
    headers.set("authorization", `Bearer ${auth.access}`)
    if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId)
    const residency = extractResidency(auth.access)
    if (residency) headers.set("x-openai-internal-codex-residency", residency)
    return networkFetch(url, { ...init, headers, redirect: "error" })
  }
}

export function createReplayCodexModel(auth: ReplayOAuth, networkFetch: ReplayNetworkFetch = fetch) {
  const openai = createOpenAI({
    apiKey: DUMMY_KEY,
    baseURL: CODEX_BASE_URL,
    fetch: createReplayCodexFetch(auth, networkFetch) as typeof fetch,
  })
  return openai.responses(REPLAY_API_MODEL)
}
