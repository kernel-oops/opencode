import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  bindExternalTextFile,
  closeBoundExternalTextFile,
  readBoundExternalTextFile,
} from "../../src/tool/external-read-bound-file"

for (const mutation of [
  "siblings",
  "content",
  "replacement",
  "parent",
  "parent-symlink",
  "symlink",
  "mount",
] as const) {
  test(`pinned external text: ${mutation}`, async () => {
    if (process.platform !== "linux") return
    const outer = await mkdtemp("/tmp/opencode-pinned-text-")
    const root = path.join(outer, "root")
    await mkdir(root)
    const target = path.join(root, "target.txt")
    await writeFile(target, "1) original\n")
    const bound = await bindExternalTextFile(target)
    expect(bound).toBeDefined()
    if (!bound) throw new Error("fixture did not bind")
    try {
      if (mutation === "siblings") {
        await writeFile(path.join(root, "sibling.txt"), "unrelated")
        await mkdir(path.join(root, "directory"))
        await rm(path.join(root, "sibling.txt"))
        await rm(path.join(root, "directory"), { recursive: true })
        expect((await readBoundExternalTextFile(bound)).toString()).toBe("1) original\n")
        return
      }
      if (mutation === "content") await writeFile(target, "2) modified\n")
      if (mutation === "replacement") {
        await rename(target, path.join(root, "old.txt"))
        await writeFile(target, "1) original\n")
      }
      if (mutation === "parent") {
        await rename(root, path.join(outer, "old-root"))
        await mkdir(root)
        await writeFile(target, "1) original\n")
      }
      if (mutation === "parent-symlink") {
        await rename(root, path.join(outer, "old-root"))
        await symlink(path.join(outer, "old-root"), root)
      }
      if (mutation === "mount") {
        await expect(
          readBoundExternalTextFile({
            ...bound,
            rootGeneration: { ...bound.rootGeneration, mountID: "different-mount" },
          }),
        ).rejects.toThrow("Pinned external text file changed")
        return
      }
      if (mutation === "symlink") {
        await rename(target, path.join(root, "old.txt"))
        await symlink(path.join(root, "old.txt"), target)
      }
      await expect(readBoundExternalTextFile(bound)).rejects.toThrow("Pinned external text file changed")
    } finally {
      await closeBoundExternalTextFile(bound)
      await rm(outer, { recursive: true, force: true })
    }
  })
}
