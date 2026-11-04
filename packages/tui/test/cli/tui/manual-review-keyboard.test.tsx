/** @jsxImportSource @opentui/solid */
import type { PermissionRequest } from "@opencode/client"
import type { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, createSignal, onMount } from "solid-js"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { InteractivityProvider } from "../../../src/context/interactivity"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { ConfigProvider } from "../../../src/config"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const review = {
  id: "per_scoped",
  sessionID: "ses_scoped",
  action: "shell",
  resources: ["echo scoped"],
  review: { kind: "model-refusal" as const, reason: "Synthetic model refusal" },
  metadata: { action: { identity: "shell", arguments: { command: "echo benign" }, cwd: "/synthetic", complete: true } },
} satisfies PermissionRequest

type Options = {
  width?: number
  // Overrides the server's reply; the default accepts it with 204.
  respond?: () => Response | Promise<Response>
}

async function mountReview(root: string, initial: PermissionRequest, options: Options = {}) {
  const [active, setActive] = createSignal(false)
  const [request, setRequest] = createSignal(initial)
  const replies: { path: string; body: unknown }[] = []
  const mutations: string[] = []
  const submissions: string[] = []
  const errors: string[] = []
  const ready = Promise.withResolvers<void>()
  let peer!: TextareaRenderable
  const transport = createFetch((url, input) => {
    if (url.pathname === "/api/session/ses_scoped")
      return json({
        data: {
          id: "ses_scoped",
          title: "Scoped session",
          projectID: "proj_test",
          location: { directory: root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === "/api/session/ses_scoped/permission") return json({ data: [request()] })
    if (url.pathname.endsWith("/reply"))
      return input.json().then((body) => {
        replies.push({ path: url.pathname, body })
        return options.respond ? options.respond() : new Response(null, { status: 204 })
      })
    if (input.method !== "GET") mutations.push(`${input.method} ${url.pathname}`)
  }, createEventStream())

  function Pane() {
    const data = useData()
    const toast = useToast()
    createEffect(() => {
      if (toast.currentToast?.variant === "error") errors.push(toast.currentToast.message)
    })
    onMount(
      () =>
        void Promise.all([data.session.sync("ses_scoped"), data.session.permission.sync("ses_scoped")]).then(
          () => ready.resolve(),
          ready.reject,
        ),
    )
    return (
      <box>
        <InteractivityProvider enabled={!active()}>
          <textarea
            ref={(value) => (peer = value)}
            focused={!active()}
            initialValue="peer"
            onSubmit={() => submissions.push(peer.plainText)}
          />
        </InteractivityProvider>
        <InteractivityProvider enabled={active()}>
          <PermissionPrompt request={request()} />
        </InteractivityProvider>
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={root}>
                <LocationProvider>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <ToastProvider>
                      <Pane />
                    </ToastProvider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: options.width ?? 90, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await ready.promise
  await app.renderOnce()
  const activate = async () => {
    setActive(true)
    await app.renderOnce()
  }
  const click = async (label: string) => {
    await app.renderOnce()
    const frame = app.captureCharFrame().split("\n")
    const row = frame.findIndex((line) => line.includes(label))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(frame[row]!.indexOf(label) + 1, row)
  }
  return { app, activate, setActive, setRequest, replies, mutations, submissions, errors, peer, click }
}

const path = (id: string) => `/api/session/ses_scoped/permission/${id}/reply`

test("keyboard review starts on Don't approve, so a first Enter rejects only once", async () => {
  await using tmp = await tmpdir()
  const pane = await mountReview(tmp.path, review)
  try {
    await pane.activate()
    const frame = pane.app.captureCharFrame()
    expect(frame).toContain("Don't approve")
    expect(frame).toContain("Approve once")
    expect(frame).toContain("⇆ select · enter confirm · tab next · esc reject")
    expect(frame).not.toContain("Always")
    expect(pane.app.renderer.currentFocusedEditor).toBeNull()
    pane.app.mockInput.pressEnter()
    pane.app.mockInput.pressEnter()
    await pane.app.waitFor(() => pane.replies.length === 1)
    await Bun.sleep(20)
    expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: "reject" } }])
    expect(pane.submissions).toEqual([])
    expect(pane.mutations).toEqual([])
  } finally {
    pane.app.renderer.destroy()
  }
})

for (const keys of [["right"], ["down"], ["left"], ["up"], ["l"], ["right", "left", "right"]] as const) {
  test(`action focus ${keys.join(",")} selects Approve once and Enter sends one owning review_once`, async () => {
    await using tmp = await tmpdir()
    const pane = await mountReview(tmp.path, review)
    try {
      await pane.activate()
      for (const key of keys) {
        if (key === "l") pane.app.mockInput.pressKey("l")
        else pane.app.mockInput.pressArrow(key)
      }
      await pane.app.renderOnce()
      pane.app.mockInput.pressEnter()
      pane.app.mockInput.pressEnter()
      await pane.app.waitFor(() => pane.replies.length === 1)
      await Bun.sleep(20)
      expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: "review_once" } }])
      expect(pane.submissions).toEqual([])
      expect(pane.mutations).toEqual([])
    } finally {
      pane.app.renderer.destroy()
    }
  })
}

test("Tab reaches the phrase field, whose arrows edit the caret, and the exact phrase approves once", async () => {
  await using tmp = await tmpdir()
  const pane = await mountReview(tmp.path, review)
  try {
    await pane.activate()
    pane.app.mockInput.pressTab()
    pane.app.mockInput.pressTab()
    await pane.app.renderOnce()
    const input = pane.app.renderer.currentFocusedEditor
    expect(input).not.toBeNull()
    expect(input?.id).not.toBe(pane.peer.id)
    expect(pane.app.captureCharFrame()).toContain("type the phrase · enter approve · tab next · esc reject")
    await pane.app.mockInput.typeText("I approve per_scopd")
    pane.app.mockInput.pressArrow("left")
    await pane.app.mockInput.typeText("e")
    pane.app.mockInput.pressArrow("up")
    pane.app.mockInput.pressArrow("down")
    pane.app.mockInput.pressKey("h")
    pane.app.mockInput.pressBackspace()
    await pane.app.renderOnce()
    expect(pane.app.renderer.currentFocusedEditor?.id).toBe(input?.id)
    expect(input?.plainText).toBe("I approve per_scoped")
    pane.app.mockInput.pressEnter()
    pane.app.mockInput.pressEnter()
    await pane.app.waitFor(() => pane.replies.length === 1)
    await Bun.sleep(20)
    expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: "review_once" } }])
    expect(pane.submissions).toEqual([])
  } finally {
    pane.app.renderer.destroy()
  }
})

test("Tab and Shift+Tab cycle predictably between both actions and the phrase field", async () => {
  await using tmp = await tmpdir()
  const pane = await mountReview(tmp.path, review)
  try {
    await pane.activate()
    pane.app.mockInput.pressTab({ shift: true })
    await pane.app.renderOnce()
    const input = pane.app.renderer.currentFocusedEditor
    expect(input).not.toBeNull()
    pane.app.mockInput.pressTab({ shift: true })
    await pane.app.renderOnce()
    expect(pane.app.renderer.currentFocusedEditor).toBeNull()
    pane.app.mockInput.pressTab()
    await pane.app.renderOnce()
    expect(pane.app.renderer.currentFocusedEditor?.id).toBe(input?.id)
    pane.app.mockInput.pressTab()
    await pane.app.renderOnce()
    expect(pane.app.renderer.currentFocusedEditor).toBeNull()
    // Back on Don't approve after a full cycle.
    pane.app.mockInput.pressEnter()
    await pane.app.waitFor(() => pane.replies.length === 1)
    expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: "reject" } }])
  } finally {
    pane.app.renderer.destroy()
  }
})

for (const text of ["", "I approve", "I approve per_other", '"I approve per_scoped"', "I approve per_scoped now", "approve it"]) {
  test(`a malformed or foreign phrase keeps its draft and sends nothing: ${JSON.stringify(text)}`, async () => {
    await using tmp = await tmpdir()
    const pane = await mountReview(tmp.path, review)
    try {
      await pane.activate()
      pane.app.mockInput.pressTab({ shift: true })
      await pane.app.renderOnce()
      if (text) await pane.app.mockInput.typeText(text)
      pane.app.mockInput.pressEnter()
      await pane.app.waitFor(() => pane.errors.length > 0)
      expect(pane.errors).toContain("Enter the exact approval phrase for this pending request")
      expect(pane.replies).toEqual([])
      expect(pane.app.renderer.currentFocusedEditor?.plainText).toBe(text)
    } finally {
      pane.app.renderer.destroy()
    }
  })
}

for (const failure of [
  {
    name: "an expired request",
    respond: () =>
      json(
        { _tag: "PermissionNotFoundError", requestID: "per_scoped", message: "Permission request not found: per_scoped" },
        { status: 404 },
      ),
    message: "Permission request not found: per_scoped",
  },
  {
    name: "a server failure",
    respond: () => json({ _tag: "UnknownError", message: "Synthetic reply failure" }, { status: 500 }),
    message: "",
  },
]) {
  test(`${failure.name} reports an error and keeps the typed draft`, async () => {
    await using tmp = await tmpdir()
    const pane = await mountReview(tmp.path, review, { respond: failure.respond })
    try {
      await pane.activate()
      pane.app.mockInput.pressTab({ shift: true })
      await pane.app.renderOnce()
      const input = pane.app.renderer.currentFocusedEditor
      await pane.app.mockInput.typeText("I approve per_scoped")
      pane.app.mockInput.pressEnter()
      await pane.app.waitFor(() => pane.errors.length > 0)
      if (failure.message) expect(pane.errors.join("\n")).toContain(failure.message)
      expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: "review_once" } }])
      expect(input?.plainText).toBe("I approve per_scoped")
      expect(pane.submissions).toEqual([])
    } finally {
      pane.app.renderer.destroy()
    }
  })
}

test("Escape rejects from either the actions or the phrase field", async () => {
  for (const shift of [false, true]) {
    await using tmp = await tmpdir()
    const pane = await mountReview(tmp.path, review)
    try {
      await pane.activate()
      if (shift) {
        pane.app.mockInput.pressTab({ shift: true })
        await pane.app.mockInput.typeText("I approve per_scoped")
      }
      pane.app.mockInput.pressEscape()
      await pane.app.waitFor(() => pane.replies.length === 1)
      expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: "reject" } }])
    } finally {
      pane.app.renderer.destroy()
    }
  }
})

for (const button of [
  { label: "Don't approve", decision: "reject" },
  { label: "Approve once", decision: "review_once" },
]) {
  test(`mouse ${button.label} sends ${button.decision} for its own request`, async () => {
    await using tmp = await tmpdir()
    const pane = await mountReview(tmp.path, review)
    try {
      await pane.activate()
      await pane.click(button.label)
      await pane.app.waitFor(() => pane.replies.length === 1)
      expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: button.decision } }])
    } finally {
      pane.app.renderer.destroy()
    }
  })
}

test("an inactive review ignores keys and clicks, leaving them with the focused peer", async () => {
  await using tmp = await tmpdir()
  const pane = await mountReview(tmp.path, review)
  try {
    pane.app.mockInput.pressArrow("right")
    pane.app.mockInput.pressTab()
    pane.app.mockInput.pressEscape()
    pane.app.mockInput.pressEnter()
    await pane.click("Approve once")
    await pane.click("Don't approve")
    await Bun.sleep(20)
    expect(pane.replies).toEqual([])
    expect(pane.submissions).toEqual(["peer"])
    expect(pane.app.renderer.currentFocusedEditor?.id).toBe(pane.peer.id)
  } finally {
    pane.app.renderer.destroy()
  }
})

test("an in-flight reply blocks every further keyboard and mouse decision", async () => {
  await using tmp = await tmpdir()
  const pending = Promise.withResolvers<Response>()
  const pane = await mountReview(tmp.path, review, { respond: () => pending.promise })
  try {
    await pane.activate()
    pane.app.mockInput.pressArrow("right")
    pane.app.mockInput.pressEnter()
    await pane.app.waitFor(() => pane.replies.length === 1)
    pane.app.mockInput.pressEnter()
    pane.app.mockInput.pressEscape()
    await pane.click("Don't approve")
    await pane.click("Approve once")
    await Bun.sleep(20)
    expect(pane.replies).toEqual([{ path: path("per_scoped"), body: { decision: "review_once" } }])
    pending.resolve(new Response(null, { status: 204 }))
  } finally {
    pane.app.renderer.destroy()
  }
})

test("a new pending request resets selection and draft, so it cannot inherit Approve", async () => {
  await using tmp = await tmpdir()
  const pane = await mountReview(tmp.path, review)
  try {
    await pane.activate()
    pane.app.mockInput.pressTab({ shift: true })
    await pane.app.mockInput.typeText("I approve per_scoped")
    pane.app.mockInput.pressTab()
    pane.app.mockInput.pressArrow("right")
    await pane.app.renderOnce()
    pane.setRequest({ ...review, id: "per_second" })
    await pane.app.renderOnce()
    expect(pane.app.captureCharFrame()).toContain("per_second")
    expect(pane.app.renderer.currentFocusedEditor).toBeNull()
    pane.app.mockInput.pressEnter()
    await pane.app.waitFor(() => pane.replies.length === 1)
    expect(pane.replies).toEqual([{ path: path("per_second"), body: { decision: "reject" } }])
    pane.app.mockInput.pressTab({ shift: true })
    await pane.app.renderOnce()
    expect(pane.app.renderer.currentFocusedEditor?.plainText).toBe("")
  } finally {
    pane.app.renderer.destroy()
  }
})

for (const width of [40, 80, 120]) {
  test(`at ${width} columns a long scope scrolls while both actions and the hint stay visible`, async () => {
    await using tmp = await tmpdir()
    const long = {
      ...review,
      resources: Array.from({ length: 40 }, (_, index) => `echo line-${index} ${"x".repeat(60)}`),
    }
    const pane = await mountReview(tmp.path, long, { width })
    try {
      await pane.activate()
      const frame = pane.app.captureCharFrame()
      expect(frame).toContain("Don't approve")
      expect(frame).toContain("Approve once")
      expect(frame).toContain("esc reject")
      expect(frame).toContain("line-0")
      expect(frame).not.toContain("line-39")
      const rows = frame.split("\n")
      const row = rows.findIndex((line) => line.includes("line-0"))
      await pane.app.mockMouse.scroll(rows[row]!.indexOf("line-0") + 1, row, "down")
      await pane.app.mockMouse.scroll(rows[row]!.indexOf("line-0") + 1, row, "down")
      await pane.app.renderOnce()
      const scrolled = pane.app.captureCharFrame()
      expect(scrolled).not.toBe(frame)
      expect(scrolled).toContain("Don't approve")
      expect(scrolled).toContain("Approve once")
      expect(pane.replies).toEqual([])
    } finally {
      pane.app.renderer.destroy()
    }
  })
}
