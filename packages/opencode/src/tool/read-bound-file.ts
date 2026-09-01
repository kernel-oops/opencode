import { constants, watch, type FSWatcher } from "node:fs"
import { lstat, open, statfs, type FileHandle } from "node:fs/promises"
import path from "node:path"
import { isBinaryContent, isReadAttachmentContent } from "@/util/media"
import {
  digestExactBytes,
  generation,
  opaqueBindingID,
  readExactBytes,
  sameGeneration,
  type BoundGeneration,
} from "./bound-generation"

const MAX_BOUND_TEXT_BYTES = 1024 * 1024
const MAX_BOUND_PATH_COMPONENTS = 64
const SAMPLE_BYTES = 4096
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]
// Node's fs.watch is not a fail-closed remote-filesystem contract. Keep this route to local Linux filesystems
// whose notification semantics are exercised here; every other filesystem remains on the human-authorised path.
const INOTIFY_FILESYSTEM_TYPES = new Set([0xef53n, 0x01021994n]) // ext2/3/4 and tmpfs

export interface BoundProjectTextFile {
  readonly file: FileHandle
  readonly path: string
  readonly target: string
  readonly generation: BoundGeneration
  readonly contentDigest: string
  readonly bindingId: string
  readonly directories: readonly BoundProjectDirectory[]
  readonly instructionWatch: BoundInstructionWatch
}

interface BoundProjectDirectory {
  readonly directory: FileHandle
  readonly target: string
  readonly generation: BoundGeneration
  readonly checkInstructions: boolean
}

interface BoundInstructionWatch {
  readonly watchers: FSWatcher[]
  dirty: boolean
  closing: boolean
}

export async function bindProjectTextFile(
  root: string,
  input: string,
  options: { readonly createWatcher?: typeof watch } = {},
): Promise<BoundProjectTextFile | undefined> {
  if (process.platform !== "linux") return undefined
  const filepath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input)
  const target = path.relative(root, filepath)
  if (!target || target === ".." || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)) return undefined

  const parts = target.split(path.sep)
  if (parts.length > MAX_BOUND_PATH_COMPONENTS) return undefined
  const directories: BoundProjectDirectory[] = []
  let file: FileHandle | undefined
  let instructionWatch: BoundInstructionWatch | undefined
  let transfer = false
  try {
    instructionWatch = startInstructionWatch()
    const createWatcher = options.createWatcher ?? watch
    let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      addInstructionWatcher(instructionWatch, directory, createWatcher)
    } catch (error) {
      await directory.close().catch(() => {})
      throw error
    }
    const rootGeneration = await generation(directory)
    directories.push({ directory, target: ".", generation: rootGeneration, checkInstructions: false })
    if (!(await supportsInstructionWatchFilesystem(directory.fd))) return undefined
    const mount = rootGeneration.mountID
    let directoryTarget = ""
    for (const part of parts.slice(0, -1)) {
      directory = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      try {
        addInstructionWatcher(instructionWatch, directory, createWatcher)
      } catch (error) {
        await directory.close().catch(() => {})
        throw error
      }
      directoryTarget = directoryTarget ? path.join(directoryTarget, part) : part
      const directoryGeneration = await generation(directory)
      directories.push({
        directory,
        target: directoryTarget,
        generation: directoryGeneration,
        checkInstructions: true,
      })
      if (directoryGeneration.mountID !== mount || !(await directory.stat()).isDirectory()) return undefined
      if (await hasInstructionFile(directory.fd)) return undefined
    }

    file = await open(
      `/proc/self/fd/${directory.fd}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const stat = await file.stat({ bigint: true })
    const fileGeneration = await generation(file)
    if (
      stat.nlink !== 1n ||
      !stat.isFile() ||
      stat.size > BigInt(MAX_BOUND_TEXT_BYTES) ||
      fileGeneration.mountID !== mount
    )
      return undefined
    const sampleSize = Math.min(Number(stat.size), SAMPLE_BYTES)
    const sample = Buffer.allocUnsafe(sampleSize)
    if (sampleSize > 0) {
      const sampled = await file.read(sample, 0, sampleSize, 0)
      if (sampled.bytesRead !== sampleSize) return undefined
    }
    if (isReadAttachmentContent(sample) || isBinaryContent(sample)) return undefined
    const contentDigest = await digestExactBytes(file, Number(fileGeneration.size))
    if (!sameGeneration(fileGeneration, await generation(file))) return undefined
    const result = {
      file,
      path: filepath,
      target,
      generation: fileGeneration,
      contentDigest,
      bindingId: opaqueBindingID(),
      directories,
      instructionWatch,
    }
    await verifyBoundProjectTextFile(result)
    transfer = true
    return result
  } catch {
    return undefined
  } finally {
    if (!transfer && instructionWatch) closeInstructionWatch(instructionWatch)
    if (!transfer) await Promise.all(directories.map((item) => item.directory.close().catch(() => {})))
    if (file && !transfer) await file.close().catch(() => {})
  }
}

export async function supportsInstructionWatchFilesystem(fd: number) {
  if (process.platform !== "linux") return false
  try {
    return INOTIFY_FILESYSTEM_TYPES.has((await statfs(`/proc/self/fd/${fd}`, { bigint: true })).type)
  } catch {
    return false
  }
}

function startInstructionWatch() {
  if (process.platform !== "linux") throw new Error("Linux directory notification is unavailable")
  return { watchers: [], dirty: false, closing: false } satisfies BoundInstructionWatch
}

function addInstructionWatcher(state: BoundInstructionWatch, directory: FileHandle, createWatcher: typeof watch) {
  try {
    const watcher = createWatcher(`/proc/self/fd/${directory.fd}`, { persistent: false }, () => {
      state.dirty = true
    })
    watcher.on("error", () => {
      state.dirty = true
    })
    watcher.on("close", () => {
      if (!state.closing) state.dirty = true
    })
    state.watchers.push(watcher)
  } catch (error) {
    closeInstructionWatch(state)
    throw error
  }
}

function closeInstructionWatch(input: BoundInstructionWatch) {
  input.closing = true
  for (const watcher of input.watchers) watcher.close()
}

async function flushInstructionWatch() {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function hasInstructionFile(fd: number) {
  for (const name of INSTRUCTION_FILES) {
    try {
      await lstat(`/proc/self/fd/${fd}/${name}`)
      return true
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") return true
    }
  }
  return false
}

async function verifyBoundProjectTextFile(input: BoundProjectTextFile) {
  await flushInstructionWatch()
  if (input.instructionWatch.dirty) throw new Error("Pinned project instruction watch changed")
  for (const item of input.directories) {
    if (!sameGeneration(item.generation, await generation(item.directory)))
      throw new Error("Pinned project directory generation changed")
    if (item.checkInstructions && (await hasInstructionFile(item.directory.fd)))
      throw new Error("Pinned project instruction state changed")
  }
  if (!sameGeneration(input.generation, await generation(input.file)))
    throw new Error("Pinned project text file generation changed")
  await flushInstructionWatch()
  if (input.instructionWatch.dirty) throw new Error("Pinned project instruction watch changed")
}

export async function readBoundProjectTextFile(input: BoundProjectTextFile) {
  await verifyBoundProjectTextFile(input)
  const result = await readExactBytes(input.file, Number(input.generation.size))
  await verifyBoundProjectTextFile(input)
  if (result.digest !== input.contentDigest) throw new Error("Pinned project text file content changed")
  return result.bytes
}

export async function closeBoundProjectTextFile(input: BoundProjectTextFile, verify = false) {
  let failure: unknown
  if (verify) {
    try {
      await verifyBoundProjectTextFile(input)
    } catch (error) {
      failure = error
    }
  }
  closeInstructionWatch(input.instructionWatch)
  await Promise.all([
    input.file.close().catch(() => {}),
    ...input.directories.map((item) => item.directory.close().catch(() => {})),
  ])
  if (failure) throw failure
}
