import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

export async function trustedCanonicalAlias(lexicalInput: string, canonicalTarget: string) {
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
      // A trusted alias may only replace an ancestor directory. Accepting the
      // final component would let a directory read capability be laundered to
      // an unrelated file through a privileged-looking file symlink.
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
