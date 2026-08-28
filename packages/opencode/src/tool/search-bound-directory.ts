import { constants } from "node:fs"
import { lstat, open, stat } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"
import { mountID, opaqueBindingID, type MountIdentifier } from "./bound-generation"

const MAX_SEARCH_DEPTH = 64

interface BoundSearchDirectoryIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly mountID: string
}

export interface BoundSearchDirectory {
  readonly root: FileHandle
  readonly directory: FileHandle
  readonly cwd: string
  readonly rootPath: string
  readonly path: string
  readonly rootIdentity: BoundSearchDirectoryIdentity
  readonly identity: BoundSearchDirectoryIdentity
  readonly bindingId: string
}

async function identity(
  directory: FileHandle,
  identifyMount: MountIdentifier = mountID,
): Promise<BoundSearchDirectoryIdentity | undefined> {
  const cwd = `/proc/self/fd/${directory.fd}`
  const [info, proc, currentMount] = await Promise.all([
    directory.stat({ bigint: true }),
    stat(cwd, { bigint: true }),
    identifyMount(directory.fd),
  ])
  if (!currentMount || !info.isDirectory() || !proc.isDirectory() || proc.dev !== info.dev || proc.ino !== info.ino)
    return
  return { dev: info.dev, ino: info.ino, mountID: currentMount }
}

export async function bindSearchDirectory(
  root: string,
  search: string,
  identifyMount: MountIdentifier = mountID,
): Promise<BoundSearchDirectory | undefined> {
  if (process.platform !== "linux") return undefined

  const rootPath = path.resolve(root)
  const searchPath = path.resolve(search)
  const relative = path.relative(rootPath, searchPath)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  const parts = relative === "" ? [] : relative.split(path.sep)
  if (parts.length > MAX_SEARCH_DEPTH || parts.some((part) => part.length === 0 || part === "." || part === ".."))
    return undefined

  let rootDirectory: FileHandle | undefined
  let directory: FileHandle | undefined
  let transferred = false
  try {
    const inspected = await lstat(rootPath, { bigint: true })
    if (!inspected.isDirectory()) return undefined

    rootDirectory = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const rootIdentity = await identity(rootDirectory, identifyMount)
    if (!rootIdentity || rootIdentity.dev !== inspected.dev || rootIdentity.ino !== inspected.ino) return undefined

    directory = rootDirectory
    for (const part of parts) {
      const child = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      let retained = false
      try {
        const childIdentity = await identity(child, identifyMount)
        if (!childIdentity || childIdentity.mountID !== rootIdentity.mountID || childIdentity.dev !== rootIdentity.dev)
          return undefined
        if (directory !== rootDirectory) await directory.close()
        directory = child
        retained = true
      } finally {
        if (!retained) await child.close().catch(() => {})
      }
    }

    const directoryIdentity = await identity(directory, identifyMount)
    if (
      !directoryIdentity ||
      directoryIdentity.mountID !== rootIdentity.mountID ||
      directoryIdentity.dev !== rootIdentity.dev
    )
      return undefined

    transferred = true
    return {
      root: rootDirectory,
      directory,
      cwd: `/proc/self/fd/${directory.fd}`,
      rootPath,
      path: searchPath,
      rootIdentity,
      identity: directoryIdentity,
      bindingId: opaqueBindingID(),
    }
  } catch {
    return undefined
  } finally {
    if (!transferred) {
      if (directory && directory !== rootDirectory) await directory.close().catch(() => {})
      await rootDirectory?.close().catch(() => {})
    }
  }
}

export async function verifyBoundSearchDirectory(input: BoundSearchDirectory) {
  const rootIdentity = await identity(input.root)
  const directoryIdentity = await identity(input.directory)
  if (
    input.cwd !== `/proc/self/fd/${input.directory.fd}` ||
    !rootIdentity ||
    rootIdentity.dev !== input.rootIdentity.dev ||
    rootIdentity.ino !== input.rootIdentity.ino ||
    rootIdentity.mountID !== input.rootIdentity.mountID ||
    !directoryIdentity ||
    directoryIdentity.dev !== input.identity.dev ||
    directoryIdentity.ino !== input.identity.ino ||
    directoryIdentity.mountID !== input.identity.mountID ||
    directoryIdentity.mountID !== rootIdentity.mountID ||
    directoryIdentity.dev !== rootIdentity.dev
  ) {
    throw new Error("Pinned search directory changed")
  }
}

export async function closeBoundSearchDirectory(input: BoundSearchDirectory) {
  if (input.directory !== input.root) await input.directory.close().catch(() => {})
  await input.root.close().catch(() => {})
}
