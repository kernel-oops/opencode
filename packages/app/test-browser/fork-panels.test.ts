import { expect, test } from "bun:test"
import { createSignal, onCleanup, untrack } from "solid-js"
import { render } from "solid-js/web"
import { Slot } from "@opencode/plugin/gui"
import { BuiltinPanel } from "@opencode/plugin/gui/builtin"
import { forkPanels } from "../src/extensions/panels"
import { AppExtensions } from "../src/extensions/registry"

test("once-untracked panel host keeps count/session reactive and disposes polling owners", async () => {
  const [count, setCount] = createSignal(0)
  const [session, setSession] = createSignal("one")
  let creates = 0
  let disposed = 0
  let timers = 0
  const off = AppExtensions.panelTab({
    id: "reactive-fixture",
    create(ctx) {
      creates++
      const timer = setInterval(() => {}, 60_000)
      timers++
      onCleanup(() => {
        clearInterval(timer)
        timers--
        disposed++
      })
      return { label: () => `Background (${count()}):${ctx.sessionID()}`, content: () => `Content:${ctx.sessionID()}` }
    },
  })
  const contributions: any[] = []
  const setup = (await forkPanels.windowEntry()).default
  setup({ add: (_registry: unknown, contribution: unknown) => contributions.push(contribution) } as any)
  const panel = contributions.find((item) => item.id === "reactive-fixture")
  const state = {
    get session() {
      return { id: session() }
    },
  }
  const label = document.createElement("div")
  const content = document.createElement("div")
  const disposeLabel = render(() => untrack(() => panel.list()[0].label(state)), label)
  const disposeContent = render(() => untrack(() => panel.render(state)), content)
  try {
    expect(label.textContent).toBe("Background (0):one")
    setCount(2)
    expect(label.textContent).toBe("Background (2):one")
    setSession("two")
    expect(label.textContent).toBe("Background (2):two")
    expect(content.textContent).toBe("Content:two")
    expect(creates).toBe(2)
    expect(timers).toBe(2)
  } finally {
    disposeLabel()
    disposeContent()
    off()
  }
  expect(disposed).toBe(2)
  expect(timers).toBe(0)
})

test("feature titles, mobile views and header actions reach the upstream host", async () => {
  const [title, setTitle] = createSignal("Background")
  const opened: string[] = []
  const [state, setState] = createSignal("closed")
  const offs = [
    AppExtensions.panelTab({
      id: "titled-fixture",
      title,
      mobile: { kind: "tab", order: 15, title },
      create: () => ({ label: () => "", content: () => "" }),
      headerAction: (ctx) => `${ctx.sessionID()}:${ctx.shown()}:${(ctx.open(), "opened")}`,
    }),
    AppExtensions.panelTab({ id: "plain-fixture", create: () => ({ label: () => "", content: () => "" }) }),
  ]
  try {
    const added: { registry: unknown; value: any }[] = []
    const setup = (await forkPanels.windowEntry()).default
    setup({
      id: "kernel-oops-panels",
      add: (registry: unknown, value: unknown) => added.push({ registry, value }),
      layout: {
        state: (key: string, session: { id: string }) =>
          key === "kernel-oops-panels:titled-fixture" && session.id === "one" ? state() : "closed",
        open: (key: string, session: { id: string }) => opened.push(`${key}@${session.id}`),
      },
    } as any)
    const panel = (id: string) => added.find((item) => item.registry === BuiltinPanel && item.value.id === id)?.value
    expect(panel("titled-fixture").list()[0].title).toBe("Background")
    expect(panel("titled-fixture").mobile).toMatchObject({ kind: "tab", order: 15, title: "Background" })
    setTitle("Hintergrund")
    expect(panel("titled-fixture").list()[0].title).toBe("Hintergrund")
    expect(panel("titled-fixture").mobile.title).toBe("Hintergrund")
    expect(panel("plain-fixture").list()[0].title).toBe("plain-fixture")
    expect(panel("plain-fixture").mobile).toBeUndefined()

    const slots = added.filter((item) => item.registry === Slot)
    expect(slots.map((item) => item.value.at)).toEqual(["session.header"])
    setState("visible")
    expect(slots[0].value.render({ session: { id: "one" } })).toBe("one:true:opened")
    expect(opened).toEqual(["kernel-oops-panels:titled-fixture@one"])
  } finally {
    offs.forEach((off) => off())
  }
})
