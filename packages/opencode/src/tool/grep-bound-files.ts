import { constants } from "node:fs"
import { open, readFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import type { BoundSearchDirectory } from "./search-bound-directory"
import {
  contentGenerationDigest,
  digestExactBytes,
  generation,
  opaqueBindingID,
  readExactBytes,
  sameGeneration,
  type BoundGeneration,
  type MountIdentifier,
} from "./bound-generation"

export const LITERAL_GREP_LIMITS = {
  files: 4096,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  depth: 64,
} as const

export interface BoundGrepFile {
  readonly file: FileHandle
  readonly target: string
  readonly bytes: number
  readonly generation: BoundGeneration
  readonly contentDigest: string
}

export interface BoundGrepSnapshot {
  readonly files: readonly BoundGrepFile[]
  readonly totalBytes: number
  readonly generationDigest: string
  readonly bindingId: string
}

async function mountID(fd: number) {
  try {
    const info = await readFile(`/proc/self/fdinfo/${fd}`, "utf8")
    return /^mnt_id:\s*(\d+)$/mu.exec(info)?.[1]
  } catch {
    return undefined
  }
}

export function literalBranches(pattern: string): readonly string[] | undefined {
  if (pattern.length === 0 || pattern.length > 1024 || /[\\.^$*+?()[\]{}\r\n\0]/u.test(pattern)) return undefined
  const branches = pattern.split("|")
  if (branches.length === 0 || branches.length > 16 || branches.some((item) => item.length === 0 || item.length > 256))
    return undefined
  return branches
}

export async function bindGrepFiles(
  root: BoundSearchDirectory,
  targets: readonly string[],
  identifyMount: MountIdentifier = mountID,
): Promise<BoundGrepSnapshot | undefined> {
  if (process.platform !== "linux" || targets.length > LITERAL_GREP_LIMITS.files) return undefined
  const files: BoundGrepFile[] = []
  let transferred = false
  let totalBytes = 0
  try {
    const rootMount = await identifyMount(root.directory.fd)
    if (!rootMount) return undefined
    for (const target of targets) {
      if (
        target.length === 0 ||
        path.isAbsolute(target) ||
        path.normalize(target) !== target ||
        target === ".." ||
        target.startsWith(`..${path.sep}`)
      )
        return undefined
      const parts = target.split(path.sep)
      if (
        parts.length > LITERAL_GREP_LIMITS.depth ||
        parts.some((part) => part.length === 0 || part === "." || part === "..")
      )
        return undefined

      const directories: FileHandle[] = []
      let parent = root.directory.fd
      try {
        for (const part of parts.slice(0, -1)) {
          const directory = await open(
            `/proc/self/fd/${parent}/${part}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          )
          directories.push(directory)
          if ((await identifyMount(directory.fd)) !== rootMount || !(await directory.stat()).isDirectory())
            return undefined
          parent = directory.fd
        }
        const file = await open(
          `/proc/self/fd/${parent}/${parts.at(-1)}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        let retained = false
        try {
          const stat = await file.stat({ bigint: true })
          const fileGeneration = await generation(file, identifyMount)
          if (
            fileGeneration.mountID !== rootMount ||
            !stat.isFile() ||
            fileGeneration.nlink !== 1n ||
            fileGeneration.size > BigInt(LITERAL_GREP_LIMITS.fileBytes)
          )
            return undefined
          totalBytes += Number(fileGeneration.size)
          if (totalBytes > LITERAL_GREP_LIMITS.totalBytes) return undefined
          const bytes = Number(fileGeneration.size)
          const contentDigest = await digestExactBytes(file, bytes)
          if (!sameGeneration(fileGeneration, await generation(file, identifyMount))) return undefined
          files.push({ file, target, bytes, generation: fileGeneration, contentDigest })
          retained = true
        } finally {
          if (!retained) await file.close().catch(() => {})
        }
      } finally {
        await Promise.all(directories.map((directory) => directory.close().catch(() => {})))
      }
    }
    for (const item of files) {
      if (!sameGeneration(item.generation, await generation(item.file, identifyMount))) return undefined
    }
    transferred = true
    return {
      files,
      totalBytes,
      generationDigest: contentGenerationDigest(files),
      bindingId: opaqueBindingID(),
    }
  } catch {
    return undefined
  } finally {
    if (!transferred) await closeGrepSnapshot({ files, totalBytes, generationDigest: "", bindingId: "" })
  }
}

export async function closeGrepSnapshot(snapshot: BoundGrepSnapshot) {
  await Promise.all(snapshot.files.map((item) => item.file.close().catch(() => {})))
}

export async function readBoundGrepFile(input: BoundGrepFile) {
  const before = await generation(input.file)
  if (!sameGeneration(input.generation, before)) throw new Error("Pinned grep file generation changed")
  const result = await readExactBytes(input.file, input.bytes)
  const after = await generation(input.file)
  if (!sameGeneration(input.generation, after)) throw new Error("Pinned grep file generation changed")
  if (result.digest !== input.contentDigest) throw new Error("Pinned grep file content changed")
  return result.bytes
}
