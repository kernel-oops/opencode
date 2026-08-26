import { constants } from "node:fs"
import { lstat, open, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"

export interface BoundSearchDirectory {
  readonly directory: FileHandle
  readonly cwd: string
}

export async function bindSearchDirectory(root: string, search: string): Promise<BoundSearchDirectory | undefined> {
  if (process.platform !== "linux" || search !== root) return undefined

  let directory: FileHandle | undefined
  let transferred = false
  try {
    const inspected = await lstat(search, { bigint: true })
    if (!inspected.isDirectory()) return undefined

    directory = await open(search, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const pinned = await directory.stat({ bigint: true })
    if (!pinned.isDirectory() || pinned.dev !== inspected.dev || pinned.ino !== inspected.ino) return undefined

    const cwd = `/proc/self/fd/${directory.fd}`
    const proc = await stat(cwd, { bigint: true })
    if (!proc.isDirectory() || proc.dev !== pinned.dev || proc.ino !== pinned.ino) return undefined

    transferred = true
    return { directory, cwd }
  } catch {
    return undefined
  } finally {
    if (!transferred) await directory?.close().catch(() => {})
  }
}
