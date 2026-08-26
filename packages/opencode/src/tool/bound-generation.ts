import { createHash, randomBytes } from "node:crypto"
import { readFile, type FileHandle } from "node:fs/promises"

export interface BoundGeneration {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly nlink: bigint
  readonly ctimeNs: bigint
  readonly mtimeNs: bigint
  readonly mountID: string
}

export interface ReviewGeneration {
  readonly dev: string
  readonly ino: string
  readonly size: string
  readonly nlink: string
  readonly ctimeNs: string
  readonly mtimeNs: string
  readonly mountID: string
}

export async function mountID(fd: number) {
  const match = (await readFile(`/proc/self/fdinfo/${fd}`, "utf8")).match(/^mnt_id:\s+(\d+)$/mu)
  if (!match) throw new Error("procfs descriptor mount identity is unavailable")
  return match[1]
}

export type MountIdentifier = (fd: number) => Promise<string | undefined>

export async function generation(file: FileHandle, identifyMount: MountIdentifier = mountID): Promise<BoundGeneration> {
  const stat = await file.stat({ bigint: true })
  const mount = await identifyMount(file.fd)
  if (!mount) throw new Error("procfs descriptor mount identity is unavailable")
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    nlink: stat.nlink,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
    mountID: mount,
  }
}

export function sameGeneration(left: BoundGeneration, right: BoundGeneration) {
  // This is an unprivileged-writer boundary: a privileged writer able to restore inode timestamps is outside it.
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.mountID === right.mountID
  )
}

export function reviewGeneration(input: BoundGeneration): ReviewGeneration {
  return {
    dev: input.dev.toString(),
    ino: input.ino.toString(),
    size: input.size.toString(),
    nlink: input.nlink.toString(),
    ctimeNs: input.ctimeNs.toString(),
    mtimeNs: input.mtimeNs.toString(),
    mountID: input.mountID,
  }
}

export function generationDigest(input: readonly { readonly target: string; readonly generation: BoundGeneration }[]) {
  const hash = createHash("sha256")
  for (const item of input) {
    const value = reviewGeneration(item.generation)
    hash.update(
      JSON.stringify([
        item.target,
        value.dev,
        value.ino,
        value.size,
        value.nlink,
        value.ctimeNs,
        value.mtimeNs,
        value.mountID,
      ]),
    )
  }
  return hash.digest("hex")
}

export function contentGenerationDigest(
  input: readonly {
    readonly target: string
    readonly generation: BoundGeneration
    readonly contentDigest: string
  }[],
) {
  const hash = createHash("sha256")
  for (const item of input) {
    const value = reviewGeneration(item.generation)
    hash.update(
      JSON.stringify([
        item.target,
        value.dev,
        value.ino,
        value.size,
        value.nlink,
        value.ctimeNs,
        value.mtimeNs,
        value.mountID,
        item.contentDigest,
      ]),
    )
  }
  return hash.digest("hex")
}

export function opaqueBindingID() {
  return randomBytes(16).toString("hex")
}

async function consumeExactBytes(file: FileHandle, expected: number, retain: boolean) {
  const hash = createHash("sha256")
  const bytes = retain ? Buffer.allocUnsafe(expected) : undefined
  const chunk = retain ? bytes! : Buffer.allocUnsafe(Math.min(expected || 1, 64 * 1024))
  const extra = Buffer.allocUnsafe(1)
  try {
    let offset = 0
    while (offset < expected) {
      const length = Math.min(chunk.length, expected - offset)
      const result = await file.read(chunk, retain ? offset : 0, length, offset)
      if (result.bytesRead === 0) break
      hash.update(chunk.subarray(retain ? offset : 0, (retain ? offset : 0) + result.bytesRead))
      offset += result.bytesRead
    }
    const beyond = await file.read(extra, 0, 1, expected)
    if (offset !== expected || beyond.bytesRead !== 0) throw new Error("Pinned file size changed")
    return { bytes, digest: hash.digest("hex") }
  } finally {
    if (!retain) {
      chunk.fill(0)
      extra.fill(0)
    }
  }
}

export async function digestExactBytes(file: FileHandle, expected: number) {
  return (await consumeExactBytes(file, expected, false)).digest
}

export async function readExactBytes(file: FileHandle, expected: number) {
  const result = await consumeExactBytes(file, expected, true)
  return { bytes: result.bytes!, digest: result.digest }
}
