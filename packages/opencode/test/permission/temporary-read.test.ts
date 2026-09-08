import { expect, test } from "bun:test"
import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import planefolioTmpRules from "./fixtures/planefolio-tmp-rules.json"
import { temporaryReadAllows } from "../../src/permission/temporary-read"

for (const identity of ["read", "grep", "glob"] as const) {
  test(`temporary read target boundary and registration: ${identity}`, async () => {
    if (process.platform !== "linux") return
    const action = (target: string): PermissionReviewSnapshot["action"] => ({
      origin: "tool",
      identity,
      permission: identity,
      cwd_status: "exact",
      patterns: [],
      metadata: {},
      arguments: {
        contract: "registered-builtin-invocation-v1",
        effects_bound: false,
        invocation: identity === "read" ? { filePath: target } : { pattern: "*", path: target },
      },
      cwd: "/",
      complete: true,
      omitted_items: 0,
      omitted_bytes: 0,
    })
    const check = (value: PermissionReviewSnapshot["action"], enabled = true, permission: string = identity) =>
      temporaryReadAllows({ enabled, action: value, directory: "/", permission, ruleset: [] })
    for (const permission of [identity, "external_directory"]) {
      const rules = (ruleset: PermissionV1.Ruleset) =>
        temporaryReadAllows({
          enabled: true,
          action: action("/tmp"),
          directory: "/",
          permission,
          ruleset,
        })
      expect(await rules(planefolioTmpRules as PermissionV1.Ruleset)).toBe("allow")
      for (const pattern of ["/", "/home/marc", "/mnt/crypt", "/tmp2", "/tmp2/private"]) {
        expect(await rules([{ permission: "external_directory", pattern, action: "deny" }])).toBe("allow")
      }
      for (const pattern of [
        "/tmp/private",
        "/tmp/private/*",
        "*.env",
        "/home/*",
        "relative",
        "/tmp/../etc",
        "/etc/",
      ]) {
        expect(await rules([{ permission: "read", pattern, action: "deny" }])).toBe(false)
      }
      expect(await rules([{ permission: "read", pattern: "/tmp", action: "deny" }])).toBe("deny")
      // Extra pathname guards remain conservative when reached: a later allow does not
      // erase a potentially sensitive descendant deny. Ordinary static evaluation is unchanged.
      expect(
        await rules([
          { permission: "read", pattern: "/tmp/private", action: "deny" },
          { permission: "read", pattern: "/tmp/private", action: "allow" },
        ]),
      ).toBe(false)
      expect(
        await rules([
          { permission: "read", pattern: "/tmp", action: "deny" },
          { permission: "read", pattern: "/tmp", action: "allow" },
        ]),
      ).toBe("deny")
    }
    expect(await check(action("/tmp"))).toBe("allow")
    expect(await check(action("/tmp2"))).toBe(false)
    expect(await check(action("/tmp/../etc"))).toBe(false)
    expect(await check(action("/tmp"), false)).toBe(false)
    expect(await check(action("/tmp"), true, "bash")).toBe(false)
    expect(await check({ ...action("/tmp"), origin: "unknown" })).toBe(false)
    expect(await check({ ...action("/tmp"), complete: false })).toBe(false)
    expect(await check({ ...action("/tmp"), arguments: { filePath: "/tmp", path: "/tmp", pattern: "*" } })).toBe(false)
  })
}
