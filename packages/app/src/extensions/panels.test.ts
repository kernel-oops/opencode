import { expect, test } from "bun:test"
import { BuiltinPanel } from "@opencode/plugin/gui/builtin"
import { forkPanels } from "./panels"
import { AppExtensions } from "./registry"

test("fork panel contributions survive upstream GUI extraction and legacy tab restoration", async () => {
  const off = AppExtensions.panelTab({
    id: "fixture",
    create: (ctx) => ({ label: () => `label:${ctx.sessionID()}`, content: () => `content:${ctx.sessionID()}` }),
  })
  try {
    const contributed: any[] = []
    const setup = (await forkPanels.windowEntry()).default
    setup({ add: (registry: unknown, value: unknown) => {
      expect(registry).toBe(BuiltinPanel)
      contributed.push(value)
    } } as any)
    const panel = contributed.find((item) => item.id === "fixture")
    expect(panel.region).toBe("side")
    expect(panel.legacy).toEqual({ "ext:fixture": "fixture" })
    const tab = panel.list()[0]
    expect(tab.pinned).toBe(true)
    expect((tab.label({ session: { id: "one" } }) as () => string)()).toBe("label:one")
    expect((panel.render({ session: { id: "two" } }) as () => string)()).toBe("content:two")
  } finally {
    off()
  }
})
