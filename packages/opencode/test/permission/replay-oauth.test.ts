import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  CODEX_RESPONSES_URL,
  createReplayCodexFetch,
  loadReplayOAuth,
  type ReplayOAuth,
} from "@/permission/replay-oauth"

const roots: string[] = []

function accessToken(claims: Record<string, unknown>) {
  return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".")
}

function authFile(value: unknown) {
  const root = join(tmpdir(), `permission-replay-auth-${crypto.randomUUID()}`)
  roots.push(root)
  mkdirSync(root, { mode: 0o700 })
  const file = join(root, "auth.json")
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("isolated permission replay OAuth", () => {
  test("loads only a current OpenAI access credential", () => {
    const file = authFile({
      unrelated: { type: "api", key: "must-not-leave-store" },
      openai: {
        type: "oauth",
        access: "current-access",
        refresh: "must-not-be-loaded-into-transport",
        expires: 2_000_000,
        accountId: "account",
      },
    })
    expect(loadReplayOAuth(file, 1_000_000)).toEqual({
      auth: { access: "current-access", expires: 2_000_000, accountId: "account" },
    })
  })

  test("fails expired OAuth without making a refresh request", () => {
    let networkCalls = 0
    const file = authFile({
      openai: { type: "oauth", access: "expired", refresh: "refresh-secret", expires: 1_000_000 },
    })
    const result = loadReplayOAuth(file, 1_000_000)
    if ("auth" in result) createReplayCodexFetch(result.auth, async () => (networkCalls++, new Response()))
    expect(result).toEqual({ failure: "auth_expired" })
    expect(networkCalls).toBe(0)
  })

  test("rejects symlinks and non-private auth files", () => {
    const target = authFile({ openai: { type: "oauth", access: "x", expires: 2_000_000 } })
    chmodSync(target, 0o644)
    expect(loadReplayOAuth(target, 1_000_000)).toEqual({ failure: "auth" })
    chmodSync(target, 0o600)
    const link = `${target}.link`
    symlinkSync(target, link)
    expect(loadReplayOAuth(link, 1_000_000)).toEqual({ failure: "auth" })
    const parentLink = `${roots[roots.length - 1]}.parent-link`
    roots.push(parentLink)
    symlinkSync(join(target, ".."), parentLink)
    expect(loadReplayOAuth(join(parentLink, "auth.json"), 1_000_000)).toEqual({ failure: "auth" })
  })

  test("allows only the fixed Codex Responses destination and passes no refresh credential", async () => {
    const access = accessToken({
      "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" },
    })
    const auth: ReplayOAuth = { access, expires: 2_000_000, accountId: "account" }
    let observed: { url: string; headers: Headers; redirect: RequestRedirect | undefined } | undefined
    const fixed = createReplayCodexFetch(auth, async (input, init) => {
      observed = { url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect }
      return new Response("ok")
    })
    await fixed(CODEX_RESPONSES_URL, { method: "POST", headers: { authorization: "Bearer dummy" } })
    expect(observed?.url).toBe(CODEX_RESPONSES_URL)
    expect(observed?.headers.get("authorization")).toBe(`Bearer ${access}`)
    expect(observed?.headers.get("ChatGPT-Account-Id")).toBe("account")
    expect(observed?.headers.get("x-openai-internal-codex-residency")).toBe("eu")
    expect(observed?.redirect).toBe("error")
    expect(JSON.stringify(observed)).not.toContain("refresh")
    await expect(fixed("https://example.com/", { method: "POST" })).rejects.toThrow("unexpected network destination")
    await expect(fixed(CODEX_RESPONSES_URL, { method: "GET" })).rejects.toThrow("unexpected network destination")
  })

  for (const status of [301, 302, 307, 308]) {
    test(`does not follow or forward a ${status} redirect`, async () => {
      const auth: ReplayOAuth = { access: "redirect-access", expires: 2_000_000, accountId: "redirect-account" }
      const body = "bounded request body"
      const calls: Array<{ url: string; init: RequestInit | undefined }> = []
      const fixed = createReplayCodexFetch(auth, async (input, init) => {
        calls.push({ url: String(input), init })
        if (init?.redirect !== "error") {
          calls.push({
            url: "https://redirect.invalid/receiver",
            init: { ...init, body },
          })
        }
        return new Response(null, { status, headers: { location: "https://redirect.invalid/receiver" } })
      })

      const response = await fixed(CODEX_RESPONSES_URL, {
        method: "POST",
        redirect: "follow",
        body,
        headers: { authorization: "Bearer dummy" },
      })

      expect(response.status).toBe(status)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(CODEX_RESPONSES_URL)
      expect(calls[0]?.init?.redirect).toBe("error")
      expect(calls[0]?.init?.body).toBe(body)
      const headers = new Headers(calls[0]?.init?.headers)
      expect(headers.get("authorization")).toBe("Bearer redirect-access")
      expect(headers.get("ChatGPT-Account-Id")).toBe("redirect-account")
    })
  }
})
