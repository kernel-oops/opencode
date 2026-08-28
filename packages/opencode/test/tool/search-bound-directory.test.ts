import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  bindSearchDirectory,
  closeBoundSearchDirectory,
  verifyBoundSearchDirectory,
} from "../../src/tool/search-bound-directory"

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })))
})

async function temporary(prefix: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  created.push(directory)
  return directory
}

describe("bound search directory", () => {
  test("binds a lexical child descriptor-relatively and survives pathname replacement", async () => {
    if (process.platform !== "linux") return
    const outer = await temporary("opencode-bound-search-")
    const root = path.join(outer, "project")
    const child = path.join(root, "templates", "nested")
    const moved = path.join(outer, "project-reviewed")
    const replacement = path.join(outer, "replacement")
    await fs.mkdir(child, { recursive: true })
    await fs.mkdir(replacement)

    const bound = await bindSearchDirectory(root, child)
    expect(bound).toBeDefined()
    if (!bound) return
    try {
      expect(bound.root.fd).not.toBe(bound.directory.fd)
      expect(bound.path).toBe(child)
      await fs.rename(root, moved)
      await fs.symlink(replacement, root, "dir")
      await expect(verifyBoundSearchDirectory(bound)).resolves.toBeUndefined()
    } finally {
      await closeBoundSearchDirectory(bound)
    }
  })

  test("rejects parent escape, symlink components, excessive depth, and mount changes", async () => {
    if (process.platform !== "linux") return
    const outer = await temporary("opencode-bound-search-reject-")
    const root = path.join(outer, "project")
    const outside = path.join(outer, "outside")
    const child = path.join(root, "templates")
    await fs.mkdir(child, { recursive: true })
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(root, "linked"), "dir")

    expect(await bindSearchDirectory(root, outside)).toBeUndefined()
    expect(await bindSearchDirectory(root, path.join(root, "linked"))).toBeUndefined()

    const deep = Array.from({ length: 65 }, (_, index) => `d${index}`)
    expect(await bindSearchDirectory(root, path.join(root, ...deep))).toBeUndefined()

    let calls = 0
    expect(
      await bindSearchDirectory(root, child, async () => {
        calls++
        return calls === 1 ? "root-mount" : "child-mount"
      }),
    ).toBeUndefined()
  })
})
