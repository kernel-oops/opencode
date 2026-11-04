import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { localPluginDirectories } from "../src/plugin/discovery"
import { isolatedGlobal } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

test("app fixtures cannot discover plugins from the ambient config directory", async () => {
  await using root = await tmpdir()
  const global = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Global.Service
    }).pipe(Effect.provide(isolatedGlobal(root.path))),
  )
  // A Global path the fixture forgets falls back to the real XDG directory.
  for (const value of Object.values(global)) expect(path.relative(root.path, value).startsWith("..")).toBe(false)
  const directories = await localPluginDirectories(process.cwd(), global.config)
  expect(directories).toContain(path.join(global.config, "plugins"))
  expect(directories.some((directory) => directory.startsWith(Global.Path.config))).toBe(false)
})

test("tests provide Global only through the isolating fixture", async () => {
  const call = ["Global", "layerWith("].join(".")
  const offenders: string[] = []
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(import.meta.dir))
    if (
      file !== path.join("fixture", "app.ts") &&
      (await Bun.file(path.join(import.meta.dir, file)).text()).includes(call)
    )
      offenders.push(file)
  expect(offenders).toEqual([])
})
