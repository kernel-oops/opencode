export * as TrustedPathAlias from "./trusted-path-alias.js"

import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

/**
 * Whether a lexical path may be treated as its canonical target. Only root-owned, non-world-writable
 * ancestor directory symlinks (such as a home directory alias onto another mount) qualify; a symlink in
 * the final component never does, so a directory capability cannot be laundered to an unrelated file.
 */
export async function trusted(lexicalInput: string, canonicalTarget: string) {
  const lexical = path.resolve(lexicalInput)
  if (lexical === canonicalTarget) return true
  if (process.platform !== "linux" || !path.isAbsolute(canonicalTarget)) return false

  try {
    const parsed = path.parse(lexical)
    let current = parsed.root
    for (const component of lexical.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      const parent = current
      current = path.join(current, component)
      const info = await lstat(current)
      if (!info.isSymbolicLink()) continue
      if (current === lexical) return false
      const parentInfo = await lstat(parent)
      if (info.uid !== 0 || parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0) return false
      const targetInfo = await lstat(await realpath(current))
      if (targetInfo.uid !== 0 || (targetInfo.mode & 0o022) !== 0) return false
    }
    return (await realpath(lexical)) === canonicalTarget
  } catch {
    return false
  }
}
