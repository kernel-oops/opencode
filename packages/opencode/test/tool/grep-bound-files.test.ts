import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bindSearchDirectory } from "../../src/tool/search-bound-directory"
import { contentGenerationDigest, generation } from "../../src/tool/bound-generation"
import {
  bindGrepFiles,
  closeGrepSnapshot,
  LITERAL_GREP_LIMITS,
  literalBranches,
  readBoundGrepFile,
} from "../../src/tool/grep-bound-files"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-bound-grep-"))
  roots.push(directory)
  return directory
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise
    return undefined
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

describe("bound literal grep files", () => {
  test("snapshot commitment includes each file content digest", () => {
    const generationValue = { dev: 1n, ino: 2n, size: 3n, nlink: 1n, ctimeNs: 4n, mtimeNs: 5n, mountID: "6" }
    expect(
      contentGenerationDigest([{ target: "file.php", generation: generationValue, contentDigest: "a".repeat(64) }]),
    ).not.toBe(
      contentGenerationDigest([{ target: "file.php", generation: generationValue, contentDigest: "b".repeat(64) }]),
    )
  })

  test("accepts only strict literal alternations", () => {
    expect(literalBranches("alpha beta|PUBLISHED-TTL")).toEqual(["alpha beta", "PUBLISHED-TTL"])
    for (const pattern of ["alpha.*", "alpha\\|beta", "(alpha)", "alpha||beta", "alpha.beta"])
      expect(literalBranches(pattern)).toBeUndefined()
  })

  test("rejects symlinks, hard links, mount uncertainty and file-count overflow", async () => {
    if (process.platform !== "linux") return
    const directory = await root()
    const outside = await root()
    await fs.writeFile(path.join(outside, "outside.txt"), "secret")
    await fs.symlink(path.join(outside, "outside.txt"), path.join(directory, "symlink.txt"))
    await fs.link(path.join(outside, "outside.txt"), path.join(directory, "hardlink.txt"))
    await fs.writeFile(path.join(directory, "safe.txt"), "safe")
    const bound = await bindSearchDirectory(directory, directory)
    expect(bound).toBeDefined()
    if (!bound) return
    try {
      expect(await bindGrepFiles(bound, ["symlink.txt"])).toBeUndefined()
      expect(await bindGrepFiles(bound, ["hardlink.txt"])).toBeUndefined()
      let calls = 0
      expect(await bindGrepFiles(bound, ["safe.txt"], async () => (++calls === 1 ? "root" : "nested"))).toBeUndefined()
      expect(
        await bindGrepFiles(
          bound,
          Array.from({ length: LITERAL_GREP_LIMITS.files + 1 }, () => "safe.txt"),
        ),
      ).toBeUndefined()
    } finally {
      await bound.directory.close()
    }
  })

  test("pins the opened file when its pathname is replaced", async () => {
    if (process.platform !== "linux") return
    const directory = await root()
    const filepath = path.join(directory, "target.txt")
    await fs.writeFile(filepath, "original")
    const bound = await bindSearchDirectory(directory, directory)
    expect(bound).toBeDefined()
    if (!bound) return
    const snapshot = await bindGrepFiles(bound, ["target.txt"])
    expect(snapshot).toBeDefined()
    if (!snapshot) return
    try {
      const moved = path.join(directory, "moved.txt")
      await fs.rename(filepath, moved)
      await fs.writeFile(filepath, "replacement")
      const result = await readBoundGrepFile(snapshot.files[0]).catch((error: Error) => error)
      if (Buffer.isBuffer(result)) expect(result.toString()).toBe("original")
      else expect(result.message).toMatch(/generation changed|content changed/u)
    } finally {
      await closeGrepSnapshot(snapshot)
      await bound.directory.close()
    }
  })

  test("fails closed at depth, per-file and total-byte caps", async () => {
    if (process.platform !== "linux") return
    const directory = await root()
    const oversized = await fs.open(path.join(directory, "oversized.txt"), "w")
    await oversized.truncate(LITERAL_GREP_LIMITS.fileBytes + 1)
    await oversized.close()
    const names = Array.from({ length: 17 }, (_, index) => `large-${index}.txt`)
    for (const name of names) {
      const file = await fs.open(path.join(directory, name), "w")
      await file.truncate(LITERAL_GREP_LIMITS.fileBytes)
      await file.close()
    }
    const bound = await bindSearchDirectory(directory, directory)
    expect(bound).toBeDefined()
    if (!bound) return
    try {
      expect(await bindGrepFiles(bound, ["oversized.txt"])).toBeUndefined()
      expect(await bindGrepFiles(bound, names)).toBeUndefined()
      expect(await bindGrepFiles(bound, [`${"nested/".repeat(LITERAL_GREP_LIMITS.depth)}file.txt`])).toBeUndefined()
    } finally {
      await bound.directory.close()
    }
  })

  test("fails closed on rewrites, size changes and persistent or temporary links", async () => {
    if (process.platform !== "linux") return
    const directory = await root()
    const outside = await root()
    const bound = await bindSearchDirectory(directory, directory)
    expect(bound).toBeDefined()
    if (!bound) return
    const cases: readonly [string, (filepath: string) => Promise<void>, boolean][] = [
      [
        "same-size",
        async (filepath) => {
          const current = await fs.readFile(filepath)
          await fs.writeFile(filepath, Buffer.alloc(current.length, 0x78))
        },
        true,
      ],
      ["growth", (filepath) => fs.appendFile(filepath, "grown"), true],
      ["shrink", (filepath) => fs.truncate(filepath, 2), true],
      [
        "persistent-link",
        async (filepath) => {
          await fs.link(filepath, path.join(outside, "persistent-link.txt"))
        },
        true,
      ],
      [
        "temporary-link",
        async (filepath) => {
          const alias = path.join(outside, "temporary-link.txt")
          await fs.link(filepath, alias)
          await fs.unlink(alias)
        },
        false,
      ],
    ]
    try {
      for (const [name, mutate, mustFail] of cases) {
        const filepath = path.join(directory, `${name}.txt`)
        await fs.writeFile(filepath, "original content")
        const snapshot = await bindGrepFiles(bound, [`${name}.txt`])
        expect(snapshot).toBeDefined()
        if (!snapshot) continue
        try {
          await mutate(filepath)
          const result = await readBoundGrepFile(snapshot.files[0]).then(
            (bytes) => ({ bytes }),
            (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
          )
          if (mustFail)
            expect("error" in result ? result.error.message : undefined).toMatch(/(generation|content|size) changed/u)
          else if ("bytes" in result) expect(result.bytes.toString()).toBe("original content")
          else expect(result.error.message).toContain("generation changed")
        } finally {
          await closeGrepSnapshot(snapshot)
        }
      }
    } finally {
      await bound.directory.close()
    }
  })

  test("content commitment catches a same-size rewrite when generation fields appear unchanged", async () => {
    if (process.platform !== "linux") return
    const directory = await root()
    const filepath = path.join(directory, "coarse-generation.txt")
    await fs.writeFile(filepath, "original")
    const bound = await bindSearchDirectory(directory, directory)
    expect(bound).toBeDefined()
    if (!bound) return
    const snapshot = await bindGrepFiles(bound, ["coarse-generation.txt"])
    expect(snapshot).toBeDefined()
    if (!snapshot) return
    try {
      await fs.writeFile(filepath, "rewrite!")
      const current = await generation(snapshot.files[0].file)
      const coarseGeneration = { ...snapshot.files[0], generation: current }
      expect((await errorOf(readBoundGrepFile(coarseGeneration)))?.message).toContain("content changed")
    } finally {
      await closeGrepSnapshot(snapshot)
      await bound.directory.close()
    }
  })

  test("fails closed when a file is rewritten concurrently with descriptor consumption", async () => {
    if (process.platform !== "linux") return
    const directory = await root()
    const filepath = path.join(directory, "concurrent.txt")
    await fs.writeFile(filepath, Buffer.alloc(LITERAL_GREP_LIMITS.fileBytes, 0x61))
    const bound = await bindSearchDirectory(directory, directory)
    expect(bound).toBeDefined()
    if (!bound) return
    const snapshot = await bindGrepFiles(bound, ["concurrent.txt"])
    expect(snapshot).toBeDefined()
    if (!snapshot) return
    try {
      const reading = readBoundGrepFile(snapshot.files[0])
      const writing = (async () => {
        for (let index = 0; index < 8; index++)
          await fs.writeFile(filepath, Buffer.alloc(LITERAL_GREP_LIMITS.fileBytes, 0x62))
      })()
      const settled = await Promise.allSettled([reading, writing])
      expect(settled[0]?.status).toBe("rejected")
      if (settled[0]?.status === "rejected") expect(String(settled[0].reason)).toContain("generation changed")
    } finally {
      await closeGrepSnapshot(snapshot)
      await bound.directory.close()
    }
  })
})
