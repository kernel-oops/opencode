import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BoundExternalFile } from "@opencode/util/bound/external-file"
import { BoundProjectFile } from "@opencode/util/bound/project-file"
import { BoundSearchDirectory } from "@opencode/util/bound/search-directory"
import { BoundGrepFiles } from "@opencode/util/bound/grep-files"
import { ExactSearchInclude } from "@opencode/util/bound/exact-search-include"
import { TrustedPathAlias } from "@opencode/util/bound/trusted-path-alias"

const linux = process.platform === "linux"
const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })))
})

async function temporary(prefix: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  created.push(directory)
  return directory
}

describe("bound external text file", () => {
  for (const mutation of [
    "siblings",
    "content",
    "replacement",
    "parent",
    "parent-symlink",
    "symlink",
    "mount",
  ] as const) {
    test.skipIf(!linux)(`pinned external text: ${mutation}`, async () => {
      const outer = await temporary("opencode-pinned-text-")
      const root = path.join(outer, "root")
      await fs.mkdir(root)
      const target = path.join(root, "target.txt")
      await fs.writeFile(target, "1) original\n")
      const bound = await BoundExternalFile.bind(target)
      expect(bound).toBeDefined()
      if (!bound) throw new Error("fixture did not bind")
      try {
        if (mutation === "siblings") {
          await fs.writeFile(path.join(root, "sibling.txt"), "unrelated")
          await fs.mkdir(path.join(root, "directory"))
          await fs.rm(path.join(root, "sibling.txt"))
          await fs.rm(path.join(root, "directory"), { recursive: true })
          expect((await BoundExternalFile.read(bound)).toString()).toBe("1) original\n")
          return
        }
        if (mutation === "content") await fs.writeFile(target, "2) modified\n")
        if (mutation === "replacement") {
          await fs.rename(target, path.join(root, "old.txt"))
          await fs.writeFile(target, "1) original\n")
        }
        if (mutation === "parent") {
          await fs.rename(root, path.join(outer, "old-root"))
          await fs.mkdir(root)
          await fs.writeFile(target, "1) original\n")
        }
        if (mutation === "parent-symlink") {
          await fs.rename(root, path.join(outer, "old-root"))
          await fs.symlink(path.join(outer, "old-root"), root)
        }
        if (mutation === "mount") {
          await expect(
            BoundExternalFile.read({
              ...bound,
              rootGeneration: { ...bound.rootGeneration, mountID: "different-mount" },
            }),
          ).rejects.toThrow("Pinned external text file changed")
          return
        }
        if (mutation === "symlink") {
          await fs.rename(target, path.join(root, "old.txt"))
          await fs.symlink(path.join(root, "old.txt"), target)
        }
        await expect(BoundExternalFile.read(bound)).rejects.toThrow("Pinned external text file changed")
      } finally {
        await BoundExternalFile.close(bound)
      }
    })
  }

  test.skipIf(!linux)("refuses symlinks, hard links, binaries, media and oversized files", async () => {
    const root = await temporary("opencode-pinned-refuse-")
    const text = path.join(root, "text.txt")
    await fs.writeFile(text, "plain\n")
    await fs.symlink(text, path.join(root, "link.txt"))
    expect(await BoundExternalFile.bind(path.join(root, "link.txt"))).toBeUndefined()
    await fs.link(text, path.join(root, "hard.txt"))
    expect(await BoundExternalFile.bind(text)).toBeUndefined()
    await fs.rm(path.join(root, "hard.txt"))
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]))
    expect(await BoundExternalFile.bind(path.join(root, "binary.bin"))).toBeUndefined()
    await fs.writeFile(path.join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))
    expect(await BoundExternalFile.bind(path.join(root, "image.png"))).toBeUndefined()
    await fs.writeFile(path.join(root, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61))
    expect(await BoundExternalFile.bind(path.join(root, "large.txt"))).toBeUndefined()
    const bound = await BoundExternalFile.bind(text)
    expect(bound).toBeDefined()
    if (!bound) return
    try {
      expect(BoundExternalFile.processPath(bound)).toBe(`/proc/${process.pid}/fd/${bound.file.fd}`)
      expect((await fs.readFile(BoundExternalFile.processPath(bound))).toString()).toBe("plain\n")
    } finally {
      await BoundExternalFile.close(bound)
    }
  })
})

describe("bound search directory", () => {
  test.skipIf(!linux)("binds a lexical child descriptor-relatively and survives pathname replacement", async () => {
    const outer = await temporary("opencode-bound-search-")
    const root = path.join(outer, "project")
    const child = path.join(root, "templates", "nested")
    const moved = path.join(outer, "project-reviewed")
    const replacement = path.join(outer, "replacement")
    await fs.mkdir(child, { recursive: true })
    await fs.mkdir(replacement)

    const bound = await BoundSearchDirectory.bind(root, child)
    expect(bound).toBeDefined()
    if (!bound) return
    try {
      expect(bound.root.fd).not.toBe(bound.directory.fd)
      expect(bound.path).toBe(child)
      await fs.rename(root, moved)
      await fs.symlink(replacement, root, "dir")
      await expect(BoundSearchDirectory.verify(bound)).resolves.toBeUndefined()
    } finally {
      await BoundSearchDirectory.close(bound)
    }
  })

  test.skipIf(!linux)("rejects parent escape, symlink components, excessive depth, and mount changes", async () => {
    const outer = await temporary("opencode-bound-search-reject-")
    const root = path.join(outer, "project")
    const outside = path.join(outer, "outside")
    const child = path.join(root, "templates")
    await fs.mkdir(child, { recursive: true })
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(root, "linked"), "dir")

    expect(await BoundSearchDirectory.bind(root, outside)).toBeUndefined()
    expect(await BoundSearchDirectory.bind(root, path.join(root, "linked"))).toBeUndefined()

    const deep = Array.from({ length: 65 }, (_, index) => `d${index}`)
    expect(await BoundSearchDirectory.bind(root, path.join(root, ...deep))).toBeUndefined()

    let calls = 0
    expect(
      await BoundSearchDirectory.bind(root, child, async () => {
        calls++
        return calls === 1 ? "root-mount" : "child-mount"
      }),
    ).toBeUndefined()
  })
})

describe("bound project text file", () => {
  test.skipIf(!linux)("pins a page read and rejects instruction files, links and content changes", async () => {
    const root = await temporary("opencode-bound-project-")
    const supported = await (async () => {
      const handle = await fs.open(root, "r")
      try {
        return await BoundProjectFile.supportsInstructionWatchFilesystem(handle.fd)
      } finally {
        await handle.close()
      }
    })()
    const target = path.join(root, "src", "deep", "file.txt")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, "one\ntwo\nthree\n")
    const bound = await BoundProjectFile.bind(root, target)
    if (!supported) {
      expect(bound).toBeUndefined()
      return
    }
    expect(bound).toBeDefined()
    if (!bound) return
    try {
      expect(bound.target).toBe(path.join("src", "deep", "file.txt"))
      expect(bound.directories.map((item) => item.target)).toEqual([".", "src", path.join("src", "deep")])
      expect((await BoundProjectFile.read(bound)).toString()).toBe("one\ntwo\nthree\n")
      await fs.writeFile(path.join(root, "src", "AGENTS.md"), "injected")
      await expect(BoundProjectFile.read(bound)).rejects.toThrow(/Pinned project/)
    } finally {
      await BoundProjectFile.close(bound)
    }

    await fs.rm(path.join(root, "src", "AGENTS.md"))
    await fs.writeFile(path.join(root, "src", "CLAUDE.md"), "present before binding")
    expect(await BoundProjectFile.bind(root, target)).toBeUndefined()
    await fs.rm(path.join(root, "src", "CLAUDE.md"))
    expect(await BoundProjectFile.bind(root, path.join(root, "..", "escape.txt"))).toBeUndefined()
    await fs.symlink(target, path.join(root, "link.txt"))
    expect(await BoundProjectFile.bind(root, path.join(root, "link.txt"))).toBeUndefined()

    const again = await BoundProjectFile.bind(root, target)
    expect(again).toBeDefined()
    if (!again) return
    try {
      await fs.writeFile(target, "changed\n")
      await expect(BoundProjectFile.read(again)).rejects.toThrow(/Pinned project/)
    } finally {
      await BoundProjectFile.close(again)
    }
  })
})

describe("bound grep files", () => {
  test("recognises literal alternations only", () => {
    expect(BoundGrepFiles.literalBranches("needle")).toEqual(["needle"])
    expect(BoundGrepFiles.literalBranches("push|deploy")).toEqual(["push", "deploy"])
    expect(BoundGrepFiles.literalBranches("nee.le")).toBeUndefined()
    expect(BoundGrepFiles.literalBranches("a|")).toBeUndefined()
    expect(BoundGrepFiles.literalBranches("")).toBeUndefined()
  })

  test.skipIf(!linux)("pins every file below a bound directory and detects content changes", async () => {
    const root = await temporary("opencode-bound-grep-")
    await fs.mkdir(path.join(root, "nested"))
    await fs.writeFile(path.join(root, "a.txt"), "needle\n")
    await fs.writeFile(path.join(root, "nested", "b.txt"), "haystack\n")
    const directory = await BoundSearchDirectory.bind(root, root)
    expect(directory).toBeDefined()
    if (!directory) return
    try {
      const snapshot = await BoundGrepFiles.bind(directory, ["a.txt", path.join("nested", "b.txt")])
      expect(snapshot).toBeDefined()
      if (!snapshot) return
      try {
        expect(snapshot.totalBytes).toBe(16)
        expect((await BoundGrepFiles.read(snapshot.files[0])).toString()).toBe("needle\n")
        await fs.writeFile(path.join(root, "a.txt"), "changed\n")
        await expect(BoundGrepFiles.read(snapshot.files[0])).rejects.toThrow(/Pinned grep file/)
      } finally {
        await BoundGrepFiles.close(snapshot)
      }
      expect(await BoundGrepFiles.bind(directory, ["../escape.txt"])).toBeUndefined()
      expect(await BoundGrepFiles.bind(directory, ["missing.txt"])).toBeUndefined()
    } finally {
      await BoundSearchDirectory.close(directory)
    }
  })
})

describe("exact search include", () => {
  test("resolves a plain filename and rejects glob syntax", () => {
    expect(ExactSearchInclude.target({ include: "notes.txt" }, "/work")).toBe("/work/notes.txt")
    expect(ExactSearchInclude.target({ path: "/elsewhere", include: "notes.txt" }, "/work")).toBe(
      "/elsewhere/notes.txt",
    )
    expect(ExactSearchInclude.target({ path: "sub", include: "notes.txt" }, "/work")).toBe("/work/sub/notes.txt")
    expect(ExactSearchInclude.target({ include: "*.txt" }, "/work")).toBeUndefined()
    expect(ExactSearchInclude.target({ include: "a/b.txt" }, "/work")).toBeUndefined()
    expect(ExactSearchInclude.target({ include: ".." }, "/work")).toBeUndefined()
    expect(ExactSearchInclude.target({ include: "bad\nname" }, "/work")).toBeUndefined()
    expect(ExactSearchInclude.target({}, "/work")).toBeUndefined()
  })
})

describe("trusted path alias", () => {
  test.skipIf(!linux)("accepts identical paths and rejects user-owned or final-component symlinks", async () => {
    const root = await temporary("opencode-alias-")
    const real = path.join(root, "real")
    await fs.mkdir(real)
    await fs.writeFile(path.join(real, "file.txt"), "x")
    await fs.symlink(real, path.join(root, "alias"))
    expect(await TrustedPathAlias.trusted(path.join(real, "file.txt"), path.join(real, "file.txt"))).toBe(true)
    // The alias directory is owned by this unprivileged test user, so it is not trusted.
    expect(await TrustedPathAlias.trusted(path.join(root, "alias", "file.txt"), path.join(real, "file.txt"))).toBe(
      process.getuid?.() === 0 ? true : false,
    )
    await fs.symlink(path.join(real, "file.txt"), path.join(root, "file-link.txt"))
    expect(await TrustedPathAlias.trusted(path.join(root, "file-link.txt"), path.join(real, "file.txt"))).toBe(false)
  })
})
