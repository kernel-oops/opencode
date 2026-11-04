/** @jsxImportSource @opentui/solid */
import type { PermissionRequest } from "@opencode/client"
import type { TextareaRenderable } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, createSignal, onMount } from "solid-js"
import { Prompt, type PromptRef } from "../../../src/component/prompt"
import { ArgsProvider } from "../../../src/context/args"
import { RouteProvider } from "../../../src/context/route"
import { LocalProvider } from "../../../src/context/local"
import { PermissionProvider } from "../../../src/context/permission"
import { SessionTabsProvider } from "../../../src/context/session-tabs"
import { StorageProvider } from "../../../src/context/storage"
import { TuiAppProvider, TuiLifecycleProvider } from "../../../src/context/runtime"
import { AttentionProvider } from "../../../src/context/attention"
import { PluginProvider } from "../../../src/plugin/context"
import { ExitProvider } from "../../../src/context/exit"
import { PromptRefProvider } from "../../../src/context/prompt"
import { EditorContextProvider } from "../../../src/context/editor"
import { DialogProvider } from "../../../src/ui/dialog"
import { PromptHistoryProvider } from "../../../src/prompt/history"
import { PromptStashProvider } from "../../../src/prompt/stash"
import { FrecencyProvider } from "../../../src/prompt/frecency"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData, type FormWithLocation } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { InteractivityProvider } from "../../../src/context/interactivity"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { FormPrompt, FORM_MODE } from "../../../src/routes/session/form"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function mountPanes(
  root: string,
  render: () => JSX.Element,
  parentID?: string,
  // A pending manual review the server has since expired: it is listed, but replies to it are 404.
  expired?: PermissionRequest,
  // A pending manual review the server still holds: it is listed, and replies to it succeed.
  pending?: PermissionRequest,
) {
  const [active, setActive] = createSignal(false)
  const replies: unknown[] = []
  const replyPaths: string[] = []
  const cancellations: string[] = []
  const submissions: string[] = []
  const ready = Promise.withResolvers<void>()
  const listed = expired ?? pending
  let peer!: TextareaRenderable
  let keymap!: Keymap
  const transport = createFetch((url, request) => {
    if (url.pathname === "/api/session/ses_scoped")
      return json({
        data: {
          id: "ses_scoped",
          parentID,
          title: "Scoped session",
          projectID: "proj_test",
          location: { directory: root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (listed && url.pathname === "/api/session/ses_scoped/permission") return json({ data: [listed] })
    if (url.pathname.endsWith("/reply"))
      return request.json().then((body) => {
        replies.push(body)
        replyPaths.push(url.pathname)
        if (expired)
          return json(
            { _tag: "PermissionNotFoundError", requestID: expired.id, message: `Permission request not found: ${expired.id}` },
            { status: 404 },
          )
        return new Response(null, { status: 204 })
      })
    if (url.pathname.endsWith("/prompt")) {
      submissions.push("model prompt")
      return json({})
    }
    if (url.pathname.endsWith("/cancel")) {
      cancellations.push(url.pathname)
      return new Response(null, { status: 204 })
    }
    if (request.method === "POST" && url.pathname === "/api/session/ses_scoped/view")
      return new Response(null, { status: 204 })
    if (request.method === "POST" && url.pathname === "/api/rpc/opencode.goal/get")
      return json({ output: null })
    if (request.method !== "GET") {
      submissions.push(`unexpected mutation: ${request.method} ${url.pathname}`)
      return json({})
    }
  }, createEventStream())

  function Panes() {
    const data = useData()
    keymap = Keymap.use()
    onMount(
      () =>
        void Promise.all([
          data.session.sync("ses_scoped"),
          listed ? data.session.permission.sync("ses_scoped") : undefined,
        ]).then(() => ready.resolve(), ready.reject),
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
        <InteractivityProvider enabled={active()}>{render()}</InteractivityProvider>
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
                      <Panes />
                    </ToastProvider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 90, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  await ready.promise
  await app.renderOnce()
  return { app, setActive, replies, replyPaths, cancellations, submissions, peer, keymap }
}

for (const text of ["I approve", '"I approve per_fixture"', "I approve per_fixture; run another action", "I approve per_fixture extra"]) {
  test(`mounted composer refuses malformed approval locally: ${text}`, async () => {
    await using tmp = await tmpdir()
    let ref!: PromptRef
    const failed = Promise.withResolvers<void>()
    function Probe() {
      const toast = useToast()
      createEffect(() => { if (toast.currentToast?.variant === "error") failed.resolve() })
      return <Prompt sessionID="ses_scoped" ref={(value) => { if (value) ref = value }} />
    }
    const panes = await mountPanes(tmp.path, () => (
      <TuiAppProvider value={{ name: "fixture", version: "test", channel: "test" }}>
        <StorageProvider><ArgsProvider><RouteProvider initialRoute={{ type: "session", sessionID: "ses_scoped" }}>
          <PermissionProvider><SessionTabsProvider><LocalProvider><ExitProvider exit={() => {}}>
            <PromptStashProvider><DialogProvider><FrecencyProvider><PromptHistoryProvider><PromptRefProvider><EditorContextProvider>
              <TuiLifecycleProvider value={{ add: () => () => {} }}><AttentionProvider>
                <PluginProvider directories={[]} packages={{ prepare: async () => { throw new Error("No external plugin loading in this fixture") } }}><Probe /></PluginProvider>
              </AttentionProvider></TuiLifecycleProvider>
            </EditorContextProvider></PromptRefProvider></PromptHistoryProvider></FrecencyProvider></DialogProvider></PromptStashProvider>
          </ExitProvider></LocalProvider></SessionTabsProvider></PermissionProvider>
        </RouteProvider></ArgsProvider></StorageProvider>
      </TuiAppProvider>
    ))
    try {
      panes.setActive(true)
      await panes.app.renderOnce()
      ref.set({ text, pasted: [], files: [], agents: [], skills: [] })
      ref.submit()
      await failed.promise
      expect(panes.submissions).toEqual([])
      expect(panes.replies).toEqual([])
      expect(ref.current.text).toBe(text)
    } finally { panes.app.renderer.destroy() }
  })
}

test("mounted composer keeps an expired manual approval and reports it instead of clearing", async () => {
  await using tmp = await tmpdir()
  let ref!: PromptRef
  const failed = Promise.withResolvers<string>()
  const review = {
    id: "per_expired",
    sessionID: "ses_scoped",
    action: "shell",
    resources: ["echo scoped"],
    review: { kind: "model-refusal" as const, reason: "Synthetic model refusal" },
  } satisfies PermissionRequest
  function Probe() {
    const toast = useToast()
    createEffect(() => {
      if (toast.currentToast?.variant === "error") failed.resolve(toast.currentToast.message)
    })
    return <Prompt sessionID="ses_scoped" ref={(value) => { if (value) ref = value }} />
  }
  const panes = await mountPanes(tmp.path, () => (
    <TuiAppProvider value={{ name: "fixture", version: "test", channel: "test" }}>
      <StorageProvider><ArgsProvider><RouteProvider initialRoute={{ type: "session", sessionID: "ses_scoped" }}>
        <PermissionProvider><SessionTabsProvider><LocalProvider><ExitProvider exit={() => {}}>
          <PromptStashProvider><DialogProvider><FrecencyProvider><PromptHistoryProvider><PromptRefProvider><EditorContextProvider>
            <TuiLifecycleProvider value={{ add: () => () => {} }}><AttentionProvider>
              <PluginProvider directories={[]} packages={{ prepare: async () => { throw new Error("No external plugin loading in this fixture") } }}><Probe /></PluginProvider>
            </AttentionProvider></TuiLifecycleProvider>
          </EditorContextProvider></PromptRefProvider></PromptHistoryProvider></FrecencyProvider></DialogProvider></PromptStashProvider>
        </ExitProvider></LocalProvider></SessionTabsProvider></PermissionProvider>
      </RouteProvider></ArgsProvider></StorageProvider>
    </TuiAppProvider>
  ), undefined, review)
  try {
    panes.setActive(true)
    await panes.app.renderOnce()
    ref.set({ text: "I approve per_expired", pasted: [], files: [], agents: [], skills: [] })
    ref.submit()
    expect(await failed.promise).toContain("Permission request not found: per_expired")
    expect(panes.replies).toEqual([{ decision: "review_once" }])
    expect(panes.submissions).toEqual([])
    expect(ref.current.text).toBe("I approve per_expired")
  } finally { panes.app.renderer.destroy() }
})

async function mountApprovalComposer(root: string, pending?: PermissionRequest) {
  let ref!: PromptRef
  const failed = Promise.withResolvers<string>()
  function Probe() {
    const toast = useToast()
    createEffect(() => {
      if (toast.currentToast?.variant === "error") failed.resolve(toast.currentToast.message)
    })
    return <Prompt sessionID="ses_scoped" ref={(value) => { if (value) ref = value }} />
  }
  const panes = await mountPanes(root, () => (
    <TuiAppProvider value={{ name: "fixture", version: "test", channel: "test" }}>
      <StorageProvider><ArgsProvider><RouteProvider initialRoute={{ type: "session", sessionID: "ses_scoped" }}>
        <PermissionProvider><SessionTabsProvider><LocalProvider><ExitProvider exit={() => {}}>
          <PromptStashProvider><DialogProvider><FrecencyProvider><PromptHistoryProvider><PromptRefProvider><EditorContextProvider>
            <TuiLifecycleProvider value={{ add: () => () => {} }}><AttentionProvider>
              <PluginProvider directories={[]} packages={{ prepare: async () => { throw new Error("No external plugin loading in this fixture") } }}><Probe /></PluginProvider>
            </AttentionProvider></TuiLifecycleProvider>
          </EditorContextProvider></PromptRefProvider></PromptHistoryProvider></FrecencyProvider></DialogProvider></PromptStashProvider>
        </ExitProvider></LocalProvider></SessionTabsProvider></PermissionProvider>
      </RouteProvider></ArgsProvider></StorageProvider>
    </TuiAppProvider>
  ), undefined, undefined, pending)
  panes.setActive(true)
  await panes.app.renderOnce()
  return { panes, failed, prompt: () => ref }
}

const pendingApproval = {
  id: "per_scoped",
  sessionID: "ses_scoped",
  action: "shell",
  resources: ["echo scoped"],
  review: { kind: "model-refusal" as const, reason: "Synthetic model refusal" },
} satisfies PermissionRequest

test("mounted approval without the phrase names the phrase, keeps the draft, and sends nothing", async () => {
  await using tmp = await tmpdir()
  const mounted = await mountApprovalComposer(tmp.path)
  try {
    mounted.prompt().set({ text: "I approve", pasted: [], files: [], agents: [], skills: [] })
    mounted.prompt().submit()
    expect(await mounted.failed.promise).toBe("Enter the exact approval phrase: I approve per_<request ID>.")
    expect(mounted.prompt().current.text).toBe("I approve")
    expect(mounted.panes.replies).toEqual([])
    expect(mounted.panes.submissions).toEqual([])
    expect(mounted.panes.cancellations).toEqual([])
  } finally { mounted.panes.app.renderer.destroy() }
})

test("mounted approval with no matching pending request says so, keeps the draft, and sends nothing", async () => {
  await using tmp = await tmpdir()
  const mounted = await mountApprovalComposer(tmp.path)
  try {
    mounted.prompt().set({ text: "I approve per_missing", pasted: [], files: [], agents: [], skills: [] })
    mounted.prompt().submit()
    expect(await mounted.failed.promise).toBe(
      "No matching pending approval request is available in this session. It may have expired or belong to another session. Request a fresh approval after confirming the earlier action did not run.",
    )
    expect(mounted.prompt().current.text).toBe("I approve per_missing")
    expect(mounted.panes.replies).toEqual([])
    expect(mounted.panes.submissions).toEqual([])
    expect(mounted.panes.cancellations).toEqual([])
  } finally { mounted.panes.app.renderer.destroy() }
})

test("mounted approval with attached context names the rule, keeps the draft and attachment, and sends nothing", async () => {
  await using tmp = await tmpdir()
  const mounted = await mountApprovalComposer(tmp.path, pendingApproval)
  try {
    mounted.prompt().set({
      text: "I approve per_scoped",
      pasted: [{ text: "extra context", source: { start: 0, end: 0, text: "[Pasted text]" } }],
      files: [],
      agents: [],
      skills: [],
    })
    mounted.prompt().submit()
    expect(await mounted.failed.promise).toBe(
      "Send the approval phrase by itself, without attachments or additional context, or use the pending request’s approval button.",
    )
    expect(mounted.prompt().current.text).toBe("I approve per_scoped")
    expect(mounted.prompt().current.pasted).toHaveLength(1)
    expect(mounted.panes.replies).toEqual([])
    expect(mounted.panes.submissions).toEqual([])
    expect(mounted.panes.cancellations).toEqual([])
  } finally { mounted.panes.app.renderer.destroy() }
})

test("mounted exact pending approval with no attachments posts review_once to its own session", async () => {
  await using tmp = await tmpdir()
  const mounted = await mountApprovalComposer(tmp.path, pendingApproval)
  try {
    mounted.prompt().set({ text: "I approve per_scoped", pasted: [], files: [], agents: [], skills: [] })
    mounted.prompt().submit()
    await mounted.panes.app.waitFor(() => mounted.panes.replies.length === 1)
    expect(mounted.panes.replies).toEqual([{ decision: "review_once" }])
    expect(mounted.panes.replyPaths).toEqual(["/api/session/ses_scoped/permission/per_scoped/reply"])
    expect(mounted.panes.submissions).toEqual([])
  } finally { mounted.panes.app.renderer.destroy() }
})

function form(fields: FormWithLocation["fields"]): FormWithLocation {
  return { id: "frm_scoped", sessionID: "ses_scoped", title: "Scoped form", fields }
}

const request = {
  id: "per_scoped",
  sessionID: "ses_scoped",
  action: "shell",
  resources: ["echo scoped"],
} satisfies PermissionRequest

test("an inactive form leaves Enter, navigation, and paste with the focused peer", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => (
    <FormPrompt
      form={form([
        {
          key: "target",
          type: "string",
          options: [
            { value: "staging", label: "Staging" },
            { value: "production", label: "Production" },
          ],
        },
      ])}
    />
  ))
  try {
    expect(panes.keymap.mode.current()).toBe("base")
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    panes.app.mockInput.pressEnter()
    panes.app.mockInput.pressArrow("down")
    panes.app.mockInput.pressKey("2")
    panes.app.mockInput.pressEscape()
    await panes.app.mockInput.pasteBracketedText(" pasted")
    expect(panes.submissions).toEqual(["peer"])
    expect(panes.peer.plainText).toContain("pasted")
    expect(panes.replies).toEqual([])
    expect(panes.cancellations).toEqual([])

    panes.setActive(true)
    expect(panes.keymap.mode.current()).toBe(FORM_MODE)
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ answer: { target: "staging" } }])
  } finally {
    panes.app.renderer.destroy()
  }
})

test("a form textarea mounts inactive and restores its draft focus after scope and modal changes", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => <FormPrompt form={form([{ key: "notes", type: "string" }])} />)
  try {
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    panes.setActive(true)
    const input = panes.app.renderer.currentFocusedEditor
    expect(input).not.toBeNull()
    expect(input?.id).not.toBe(panes.peer.id)
    await panes.app.mockInput.typeText("draft answer")

    const pop = panes.keymap.mode.push("modal")
    expect(panes.app.renderer.currentFocusedEditor).toBeNull()
    panes.setActive(false)
    panes.setActive(true)
    expect(panes.keymap.mode.current()).toBe("modal")
    expect(panes.app.renderer.currentFocusedEditor).toBeNull()
    pop()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(input?.id)

    panes.setActive(false)
    input?.focus()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    await panes.app.mockInput.typeText(" other")
    await panes.app.mockInput.pasteBracketedText(" pane")
    panes.app.mockInput.pressEnter()
    expect(panes.submissions).toHaveLength(1)
    expect(input?.plainText).toBe("draft answer")
    expect(panes.replies).toEqual([])

    panes.setActive(true)
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(input?.id)
    panes.app.mockInput.pressEnter()
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ answer: { notes: "draft answer" } }])
  } finally {
    panes.app.renderer.destroy()
  }
})

test("inactive custom forms cannot intercept a peer using the same form mode", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => (
    <FormPrompt
      form={form([{ key: "target", type: "string", options: [{ value: "staging", label: "Staging" }], custom: true }])}
    />
  ))
  try {
    panes.setActive(true)
    panes.app.mockInput.pressArrow("down")
    panes.setActive(false)
    const pop = panes.keymap.mode.push(FORM_MODE)
    await panes.app.mockInput.typeText(" typed")
    await panes.app.mockInput.pasteBracketedText(" pasted")
    panes.app.mockInput.pressEnter()
    await panes.app.renderOnce()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    expect(panes.submissions).toHaveLength(1)
    expect(panes.peer.plainText).toContain("typed")
    expect(panes.peer.plainText).toContain("pasted")
    expect(panes.app.captureCharFrame()).toContain("Type your own answer")
    expect(panes.replies).toEqual([])
    pop()

    panes.setActive(true)
    await panes.app.mockInput.typeText("production target")
    await panes.app.waitFor(() => panes.app.renderer.currentFocusedEditor?.plainText === "production target")
    panes.setActive(false)
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    panes.setActive(true)
    expect(panes.app.renderer.currentFocusedEditor?.plainText).toBe("production target")
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ answer: { target: "production target" } }])
  } finally {
    panes.app.renderer.destroy()
  }
})

test("permission layers leave the focused peer's Enter and navigation alone until activated", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => <PermissionPrompt request={request} />)
  try {
    panes.app.mockInput.pressEnter()
    panes.app.mockInput.pressArrow("right")
    panes.app.mockInput.pressEscape()
    expect(panes.submissions).toEqual(["peer"])
    expect(panes.replies).toEqual([])
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)

    panes.setActive(true)
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ decision: "once" }])
    expect(panes.submissions).toHaveLength(1)
  } finally {
    panes.app.renderer.destroy()
  }
})

test("manual model review accepts only its exact typed ID and sends review_once", async () => {
  await using tmp = await tmpdir()
  const review = { ...request, review: { kind: "model-refusal" as const, reason: "Synthetic model refusal" }, metadata: { action: { identity: "shell", arguments: { command: "echo benign" }, cwd: "/synthetic", complete: true } } }
  const panes = await mountPanes(tmp.path, () => <PermissionPrompt request={review} />)
  try {
    panes.setActive(true)
    await panes.app.renderOnce()
    const frame = panes.app.captureCharFrame()
    expect(frame).toContain("per_scoped")
    expect(frame).toContain("Synthetic model refusal")
    expect(frame).not.toContain("Always")
    panes.app.mockInput.pressTab({ shift: true })
    panes.app.mockInput.pressEnter()
    expect(panes.replies).toEqual([])
    await panes.app.mockInput.typeText("I approve per_scoped")
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ decision: "review_once" }])
  } finally {
    panes.app.renderer.destroy()
  }
})

test("permission rejection text keeps its draft and regains focus when its scope resumes", async () => {
  await using tmp = await tmpdir()
  const panes = await mountPanes(tmp.path, () => <PermissionPrompt request={request} />, "ses_parent")
  try {
    panes.setActive(true)
    panes.app.mockInput.pressEscape()
    await panes.app.waitForFrame((frame) => frame.includes("Reject permission"))
    const input = panes.app.renderer.currentFocusedEditor
    expect(input).not.toBeNull()
    await panes.app.mockInput.typeText("choose another command")

    panes.setActive(false)
    panes.app.mockInput.pressEnter()
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(panes.peer.id)
    expect(panes.submissions).toEqual(["peer"])
    expect(panes.replies).toEqual([])
    expect(input?.plainText).toBe("choose another command")

    panes.setActive(true)
    expect(panes.app.renderer.currentFocusedEditor?.id).toBe(input?.id)
    panes.app.mockInput.pressEnter()
    await panes.app.waitFor(() => panes.replies.length === 1)
    expect(panes.replies).toEqual([{ decision: "reject", message: "choose another command" }])
  } finally {
    panes.app.renderer.destroy()
  }
})
