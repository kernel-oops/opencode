import path from "node:path"

export function exactSearchIncludeTarget(input: unknown, directory: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return
  const invocation = input as { readonly path?: unknown; readonly include?: unknown }
  const include = invocation.include
  if (
    typeof include !== "string" ||
    include.length === 0 ||
    include === "." ||
    include === ".." ||
    /[\u0000-\u001f\u007f\\/!*?\[\]{}]/u.test(include)
  )
    return
  if (invocation.path !== undefined && typeof invocation.path !== "string") return
  return path.join(path.resolve(directory, invocation.path ?? directory), include)
}
