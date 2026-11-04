export * as ExactSearchInclude from "./exact-search-include.js"

import path from "node:path"

const GLOB_OR_SEPARATOR = /[\\/!*?[\]{}]/u

/** A grep `include` naming one plain file (no glob syntax, separators or control characters) resolves to that exact target. */
export function target(input: unknown, directory: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const invocation = input as { readonly path?: unknown; readonly include?: unknown }
  const include = invocation.include
  if (typeof include !== "string" || include.length === 0 || include === "." || include === "..") return undefined
  if (GLOB_OR_SEPARATOR.test(include)) return undefined
  for (const char of include) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return undefined
  }
  if (invocation.path !== undefined && typeof invocation.path !== "string") return undefined
  return path.join(path.resolve(directory, invocation.path ?? directory), include)
}
