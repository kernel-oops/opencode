import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"
import { mkdir, copyFile } from "node:fs/promises"
import path from "node:path"

const peers = new Set([
  "@opentui/core", "@opentui/solid", "@opentui/solid/components",
  "solid-js", "solid-js/store", "@opencode/plugin/tui",
])
const result = await Bun.build({
  entrypoints: [new URL("./src/tui.tsx", import.meta.url).pathname],
  outdir: new URL("./dist", import.meta.url).pathname,
  naming: "tui.js",
  target: "bun",
  format: "esm",
  plugins: [
    { name: "host-runtime", setup(build) {
      build.onResolve({ filter: /^opentui:runtime-module:/ }, (input) => ({ path: input.path, external: true }))
    } },
    createSolidTransformPlugin({
      moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
      resolvePath: (specifier) => peers.has(specifier) ? runtimeModuleIdForSpecifier(specifier) : null,
    }),
  ],
})
if (!result.success) throw new AggregateError(result.logs, "Background task CLI plugin build failed")
const helpers = await Bun.build({
  entrypoints: [new URL("./src/session.ts", import.meta.url).pathname],
  outdir: new URL("./dist", import.meta.url).pathname,
  naming: "session.js", target: "bun", format: "esm",
})
if (!helpers.success) throw new AggregateError(helpers.logs, "Session helper build failed")
const types = Bun.spawnSync([process.execPath, "run", "types"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" })
if (types.exitCode !== 0) throw new Error(types.stderr.toString())
const requested = process.argv.find((arg) => arg.startsWith("--package-dir="))?.slice("--package-dir=".length)
const destination = requested ?? path.resolve(import.meta.dir, "../../../../runtime/packages/background-tasks")
if (!path.isAbsolute(destination) || destination === import.meta.dir) throw new Error("A separate absolute package directory is required")
const manifest = await Bun.file(new URL("./package.public.json", import.meta.url)).json()
await mkdir(destination, { recursive: true })
await Bun.write(path.join(destination, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
for (const file of manifest.files) {
  await mkdir(path.dirname(path.join(destination, file)), { recursive: true })
  await copyFile(path.join(import.meta.dir, file), path.join(destination, file))
}
