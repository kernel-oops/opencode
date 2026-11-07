/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { TaskControls, useTaskControls } from "../../../src/component/task-controls"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { RouteProvider } from "../../../src/context/route"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("a paused controller appears in the row and palette through the real TUI data provider", async () => {
  const sessionID = "ses_paused"
  const events = createEventStream()
  const status = Promise.withResolvers<Response>()
  const calls = createFetch(
    (url) => (url.pathname === `/api/session/${sessionID}/task` ? status.promise : undefined),
    events,
  )
  const nextEvents = createEventStream()
  const nextCalls = createFetch(
    (url) =>
      url.pathname === `/api/session/${sessionID}/task`
        ? json({ paused: false, active: true, background: [] })
        : undefined,
    nextEvents,
  )
  const nextApi = createApi(nextCalls.fetch)
  const ready = Promise.withResolvers<void>()
  let data!: ReturnType<typeof useData>
  let openPalette!: () => void
  let commands!: ReturnType<typeof Keymap.useCommands>
  let client!: ReturnType<typeof useClient>

  function Content() {
    data = useData()
    client = useClient()
    const dialog = useDialog()
    commands = Keymap.useCommands()
    openPalette = () => dialog.replace(() => <CommandPaletteDialog />)
    const controls = useTaskControls(() => sessionID)
    onMount(() => ready.resolve())
    return <TaskControls controls={controls} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ClientProvider
              api={createApi(calls.fetch)}
              service={{ reconnect: async () => ({ api: nextApi }), restart: async () => {} }}
            >
              <DataProvider directory="/project">
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <ToastProvider>
                      <DialogProvider>
                        <Content />
                      </DialogProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </RouteProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 24, kittyKeyboard: true },
  )
  try {
    await ready.promise
    const pending = data.session.task.sync(sessionID)
    expect(data.session.task.get(sessionID)).toBeUndefined()
    expect(commands().some((command) => command.id === "session.resume-controller")).toBe(false)
    status.resolve(json({ paused: true, active: false, background: [] }))
    await pending
    expect(data.session.task.get(sessionID)?.paused).toBe(true)
    await app.waitForFrame((frame) => frame.includes("Resume controller"))
    expect(app.captureCharFrame()).toContain("Automatic continuation paused")
    expect(commands().some((command) => command.id === "session.resume-controller" && command.palette)).toBe(true)
    openPalette()
    await app.waitForFrame((frame) => frame.includes("Commands"))
    expect(app.captureCharFrame()).toContain("Resume controller")
    await app.waitFor(() => client.connection.status() === "connected")
    events.disconnect()
    await app.waitFor(() => client.api === nextApi)
    await data.session.task.sync(sessionID)
    expect(data.session.task.get(sessionID)).toMatchObject({ paused: false, active: true })
  } finally {
    app.renderer.destroy()
  }
})
