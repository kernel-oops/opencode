import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import path from "node:path"
import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { registeredReadonlyPath } from "./generic-review-action"
import { bindSearchDirectory, closeBoundSearchDirectory } from "../tool/search-bound-directory"
import { mountID } from "../tool/bound-generation"

/** Configured accidental-harm policy, not an assertion that external traversal has bound effects. */
export async function temporaryReadAllows(input: {
  enabled: boolean
  action: PermissionReviewSnapshot["action"]
  directory: string
  permission: string
  ruleset: PermissionV1.Ruleset
}) {
  if (!input.enabled || process.platform !== "linux") return false
  const action = input.action
  if (
    action.origin !== "tool" ||
    !action.complete ||
    action.omitted_items !== 0 ||
    action.omitted_bytes !== 0 ||
    (input.permission !== action.identity && input.permission !== "external_directory")
  )
    return false
  const raw = registeredReadonlyPath(action, input.directory)
  if (typeof raw !== "string" || !raw || raw.split(path.sep).includes("..")) return false
  const target = path.resolve(input.directory, raw)
  if (target !== "/tmp" && !target.startsWith("/tmp/")) return false
  try {
    if ((await realpath(target)) !== target) return false
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat({ bigint: true })
      if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n)) return false
      const parent = await bindSearchDirectory("/tmp", info.isDirectory() ? target : path.dirname(target))
      if (!parent) return false
      try {
        if ((await mountID(file.fd)) !== parent.identity.mountID) return false
        // Original pattern rules are checked by Permission.ask. Also check resolved path spellings,
        // including Read's credential rules when Grep reads a directly named file. A directory may
        // contain any denied descendant: conservatively leave that traversal to normal permissions.
        const spellings = [target, path.relative(input.directory, target), path.basename(target)]
        const denies = input.ruleset.filter(
          (rule) =>
            rule.action === "deny" &&
            [input.permission, action.identity, "read", "external_directory"].some((permission) =>
              Wildcard.match(permission, rule.permission),
            ),
        )
        if (denies.some((rule) => spellings.some((value) => Wildcard.match(value, rule.pattern))))
          return "deny" as const
        // Only exact, canonical absolute patterns can be proven disjoint. In this matcher
        // an exact ancestor (including "/") does not deny its descendants. Keep uncertain
        // patterns and possible descendants conservative, even if a later rule allows them.
        if (
          info.isDirectory() &&
          denies.some((rule) => {
            const pattern = rule.pattern
            const exact = path.isAbsolute(pattern) && !/[?*\\]/u.test(pattern) && path.resolve(pattern) === pattern
            return !exact || pattern === target || pattern.startsWith(`${target}/`)
          })
        )
          return false
        return (await realpath(`/proc/self/fd/${file.fd}`)) === target && (await realpath(target)) === target
          ? ("allow" as const)
          : false
      } finally {
        await closeBoundSearchDirectory(parent)
      }
    } finally {
      await file.close()
    }
  } catch {
    return false
  }
}
