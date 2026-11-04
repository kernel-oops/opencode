import assert from "node:assert/strict"
import { $ } from "bun"

const privateName = /luna|kernel-oops\/opencode-|syncthing|\/mnt\/crypt|\bmarc\b/i
const privatePath = /^\.kernel-oops\//
const self = "script/check-hook-surface.ts"

if (process.argv.includes("--self-test")) {
  assert(privateName.test("/mnt/crypt/example"))
  assert(privateName.test("kernel-oops/opencode-example"))
  assert(privateName.test("Luna policy"))
  assert(!privateName.test("cacheKey: string"))
  assert(privatePath.test(".kernel-oops/example"))
} else {
  const base = process.argv[2] ?? "v2.2.5"
  const files = (await $`git diff --name-only --diff-filter=ACMR ${base} HEAD`.text()).trim().split("\n").filter(Boolean)
  const failures: string[] = []
  for (const file of files) {
    if (file === self) continue
    if (privatePath.test(file) || privateName.test(file)) failures.push(file)
    const patch = await $`git diff --unified=0 ${base} HEAD -- ${file}`.text()
    if (patch.split("\n").some((line) => line.startsWith("+") && !line.startsWith("+++") && privateName.test(line)))
      failures.push(file)
  }
  assert.equal(failures.length, 0, `Private names in public patch: ${[...new Set(failures)].join(", ")}`)
}
