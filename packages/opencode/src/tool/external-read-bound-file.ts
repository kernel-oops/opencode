import { constants } from "node:fs"
import { open, realpath, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { isBinaryFile, isReadAttachmentMime, sniffAttachmentMime } from "@/util/media"
import {
  digestExactBytes,
  generation,
  opaqueBindingID,
  readExactBytes,
  sameGeneration,
  type BoundGeneration,
} from "./bound-generation"

const MAX_EXTERNAL_TEXT_BYTES = 1024 * 1024
const SAMPLE_BYTES = 4096

export interface BoundExternalTextFile {
  readonly file: FileHandle
  readonly root: FileHandle
  readonly path: string
  readonly rootPath: string
  readonly fileGeneration: BoundGeneration
  readonly rootGeneration: BoundGeneration
  readonly contentDigest: string
  readonly bindingId: string
}

export async function bindExternalTextFile(input: string): Promise<BoundExternalTextFile | undefined> {
  if (process.platform !== "linux") return undefined
  const target = path.resolve(input)
  const rootPath = path.dirname(target)
  let root: FileHandle | undefined
  let file: FileHandle | undefined
  let transfer = false
  try {
    if ((await realpath(target)) !== target || (await realpath(rootPath)) !== rootPath) return undefined
    root = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const rootGeneration = await generation(root)
    const rootInfo = await root.stat({ bigint: true })
    if (!rootInfo.isDirectory() || (await realpath(`/proc/self/fd/${root.fd}`)) !== rootPath) return undefined

    file = await open(
      `/proc/self/fd/${root.fd}/${path.basename(target)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const fileInfo = await file.stat({ bigint: true })
    const fileGeneration = await generation(file)
    if (
      !fileInfo.isFile() ||
      fileInfo.nlink !== 1n ||
      fileInfo.size > BigInt(MAX_EXTERNAL_TEXT_BYTES) ||
      fileGeneration.mountID !== rootGeneration.mountID ||
      (await realpath(`/proc/self/fd/${file.fd}`)) !== target
    )
      return undefined
    const sampleSize = Math.min(Number(fileInfo.size), SAMPLE_BYTES)
    const sample = Buffer.allocUnsafe(sampleSize)
    if (sampleSize > 0) {
      const sampled = await file.read(sample, 0, sampleSize, 0)
      if (sampled.bytesRead !== sampleSize) return undefined
    }
    const mime = sniffAttachmentMime(sample, FSUtil.mimeType(target))
    if (isReadAttachmentMime(mime) || isBinaryFile(target, sample)) return undefined
    const contentDigest = await digestExactBytes(file, Number(fileGeneration.size))
    if (!sameGeneration(fileGeneration, await generation(file))) return undefined
    const result = {
      file,
      root,
      path: target,
      rootPath,
      fileGeneration,
      rootGeneration,
      contentDigest,
      bindingId: opaqueBindingID(),
    }
    if (!(await sameBoundPath(result))) return undefined
    transfer = true
    return result
  } catch {
    return undefined
  } finally {
    if (!transfer) await Promise.all([file?.close().catch(() => {}), root?.close().catch(() => {})])
  }
}

// Directory entry churn changes size/timestamps/link count, not directory identity. Verify the
// live pathname and mounts instead; retain full generation and content checks for the file.
async function sameBoundPath(input: BoundExternalTextFile) {
  try {
    if (
      (await realpath(input.rootPath)) !== input.rootPath ||
      (await realpath(input.path)) !== input.path ||
      (await realpath(`/proc/self/fd/${input.root.fd}`)) !== input.rootPath
    )
      return false
    const root = await open(input.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const current = await generation(root)
      if (
        current.dev !== input.rootGeneration.dev ||
        current.ino !== input.rootGeneration.ino ||
        current.mountID !== input.rootGeneration.mountID
      )
        return false
      const file = await open(
        `/proc/self/fd/${root.fd}/${path.basename(input.path)}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        return sameGeneration(input.fileGeneration, await generation(file))
      } finally {
        await file.close()
      }
    } finally {
      await root.close()
    }
  } catch {
    return false
  }
}

export async function readBoundExternalTextFile(input: BoundExternalTextFile) {
  if (!(await sameBoundPath(input)) || !sameGeneration(input.fileGeneration, await generation(input.file)))
    throw new Error("Pinned external text file changed")
  const result = await readExactBytes(input.file, Number(input.fileGeneration.size))
  if (
    result.digest !== input.contentDigest ||
    !(await sameBoundPath(input)) ||
    !sameGeneration(input.fileGeneration, await generation(input.file))
  )
    throw new Error("Pinned external text file changed")
  return result.bytes
}

export async function closeBoundExternalTextFile(input: BoundExternalTextFile) {
  await Promise.all([input.file.close().catch(() => {}), input.root.close().catch(() => {})])
}
