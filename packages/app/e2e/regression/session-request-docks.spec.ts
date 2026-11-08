import type { OpenCodeEvent } from "@opencode/client/promise"
import { expect, test, type Page } from "@playwright/test"
import { SERVER, holdRoute, sessionHref } from "../utils/app"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"
import { mockWorkspace, type WorkspaceInput } from "../utils/workspace"

const directory = "C:/OpenCode/RequestDocks"

const sessionID = "ses_request_docks"

const title = "Request dock regression"

test("shows a pending question dock", async ({ page }) => {
  await mockServer(page, {
    forms: [
      {
        id: "frm_question_request",
        sessionID,
        title: "Questions",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Implementation",
            description: "Which implementation should be used?",
            options: [
              { value: "minimal", label: "Minimal", description: "Use the smallest correct change" },
              { value: "extended", label: "Extended", description: "Include additional behavior" },
            ],
            custom: true,
          },
        ],
      },
    ],
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeVisible()
  await expect(page.locator('[data-component="composer"]')).toHaveCount(0)

  const rejectRequests: string[] = []
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_request`
    )
      rejectRequests.push(request.url())
  })

  await question.getByRole("button", { name: "Minimize question" }).click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByText("Select one answer")).toBeHidden()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeHidden()
  await expect(question.getByRole("radio", { name: /Extended/ })).toBeHidden()
  await expect(question.getByRole("button", { name: "Dismiss" })).toBeVisible()
  await expect(question.getByRole("button", { name: "Submit" })).toBeVisible()
  await expect(page.locator('[data-component="question-minimized-dock"]')).toHaveCount(0)
  expect(rejectRequests).toEqual([])

  await question.getByRole("button", { name: "Restore question" }).click()
  await expect(question).toBeVisible()
  await expect(question.getByText("Which implementation should be used?")).toBeVisible()
  await expect(question.getByRole("radio", { name: /Minimal/ })).toBeVisible()
  expect(rejectRequests).toEqual([])

  await question.getByRole("radio", { name: /Minimal/ }).click()

  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_request/reply`,
  )

  await question.getByRole("button", { name: "Submit" }).click()
  expect((await reply).postDataJSON()).toEqual({ answer: { q0: "minimal" } })
})

test("replies with predefined choices and the edited custom multiselect answer", async ({ page }) => {
  await mockServer(page, {
    forms: [
      {
        id: "frm_question_multiselect",
        sessionID,
        title: "Questions",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "multiselect",
            title: "Include",
            description: "Which supporting surfaces should remain visible?",
            options: [
              { value: "files", label: "Changed files" },
              { value: "terminal", label: "Terminal" },
            ],
            custom: true,
          },
        ],
      },
    ],
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const terminal = question.getByRole("checkbox", { name: "Terminal", exact: true })
  const custom = question.getByRole("checkbox", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  const cancellations: string[] = []
  page.on("request", (request) => {
    if (
      request.method() === "DELETE" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_multiselect`
    )
      cancellations.push(request.url())
  })

  await expect(files).not.toBeChecked()
  await files.click()
  await input.fill("Original custom answer")
  await expect(custom).toBeChecked()
  await expect(files).toBeChecked()
  await terminal.click()
  await expect(terminal).toBeChecked()
  await expect(custom).toBeChecked()
  await expect(files).toBeChecked()

  await custom.click()
  await expect(custom).not.toBeChecked()
  await expect(input).toHaveValue("Original custom answer")
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()
  await input.focus()
  await expect(custom).not.toBeChecked()
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()
  await custom.click()
  await expect(custom).toBeChecked()
  await expect(input).toHaveValue("Original custom answer")
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()

  await input.fill("Updated custom answer")
  await input.press("Escape")
  await expect(input).not.toBeFocused()
  await expect(question.getByRole("button", { name: "Submit", exact: true })).toBeEnabled()
  await expect(input).toHaveValue("Updated custom answer")
  await expect(custom).toBeChecked()
  await expect(files).toBeChecked()
  await expect(terminal).toBeChecked()
  expect(cancellations).toEqual([])

  const reply = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_multiselect/reply`,
  )

  await question.getByRole("button", { name: "Submit", exact: true }).press("Control+Enter")
  expect((await reply).postDataJSON()).toEqual({ answer: { q0: ["files", "terminal", "Updated custom answer"] } })
  expect(cancellations).toEqual([])
})

test("keeps a choice when a custom answer with its value is turned off, and replies once", async ({ page }) => {
  const form = {
    id: "frm_question_once",
    sessionID,
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "multiselect",
        title: "Include",
        description: "Which supporting surfaces should remain visible?",
        options: [
          { value: "files", label: "Changed files" },
          { value: "terminal", label: "Terminal" },
        ],
        custom: true,
      },
    ],
  }

  const replies: unknown[] = []
  const transport = await installSseTransport(page, { server: SERVER, retry: 20 })
  await mockServer(page, { forms: () => (replies.length > 0 ? [] : [form]) })
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/session/${sessionID}/form/frm_question_once/reply`
    )
      replies.push(request.postDataJSON())
  })
  await page.goto(sessionHref(sessionID))
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  const files = question.getByRole("checkbox", { name: "Changed files", exact: true })
  const custom = question.getByRole("checkbox", { name: "Type your own answer…", exact: true })
  const input = question.getByRole("textbox", { name: "Type your own answer…", exact: true })
  const submit = question.getByRole("button", { name: "Submit", exact: true })
  const dismiss = question.getByRole("button", { name: "Dismiss", exact: true })

  await files.click()
  await input.fill("files")
  await expect(custom).toBeChecked()
  await custom.click()
  await expect(custom).not.toBeChecked()
  await expect(files).toBeChecked()

  const reply = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/session/${sessionID}/form/frm_question_once/reply`,
  )

  await submit.click()
  expect((await reply).request().postDataJSON()).toEqual({ answer: { q0: ["files"] } })

  // The server has the answer but has not announced the form settled yet, so nothing can send it again.
  await expect(submit).toBeDisabled()
  await expect(dismiss).toBeDisabled()
  await expect(files).toHaveAttribute("aria-disabled", "true")

  await transport.send({
    id: "evt_form_replied_once",
    created: 1700000003000,
    type: "form.replied",
    location: { directory },
    data: { sessionID, id: "frm_question_once", answer: { q0: ["files"] } },
  })
  await expect(question).toHaveCount(0)
  expect(replies).toEqual([{ answer: { q0: ["files"] } }])
})

test("shows a pending permission dock", async ({ page }) => {
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  await mockServer(page, {
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [sessionID]: [
        {
          id: "permission-request",
          sessionID,
          permission: "shell",
          patterns: ["git status", "git diff"],
          metadata: {},
          always: [],
        },
      ],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  await expect(permission).toBeVisible()
  await expect(permission.getByText("git status")).toBeVisible()
  await expect(permission.getByText("git diff")).toBeVisible()
  // No save scope: Allow always would persist nothing, so only Deny and Allow once are offered.
  await expect(permission.locator('[data-slot="permission-footer-actions"] button')).toHaveCount(2)
  await expect(page.locator('[data-component="composer"]')).toHaveCount(0)

  const reply = page.waitForResponse((response) => response.request().method() === "POST")
  await permission.getByRole("button", { name: "Allow once" }).click()
  const response = await reply
  expect(new URL(response.url()).pathname).toBe(`/api/session/${sessionID}/permission/permission-request/reply`)
  expect(response.request().postDataJSON()).toEqual({ decision: "once" })
  expect(response.status()).toBe(204)
  expect(replies).toEqual([{ sessionID, permissionID: "permission-request", body: { decision: "once" } }])
  await expect(permission).toHaveCount(0)
  await expect(page.locator('[data-component="composer"]')).toBeVisible()
})

test("sends one permission reply and closes the dock when it lands, before permission.replied", async ({ page }) => {
  await mockServer(page, {
    sessionPermissions: {
      [sessionID]: [
        // A save scope, so all three actions are offered and each must lock while the reply is in flight.
        { id: "permission-request", sessionID, action: "shell", resources: ["git status"], save: ["git status"] },
      ],
    },
  })
  const replies: unknown[] = []
  const released = Promise.withResolvers<void>()
  // Answers without the `permission.replied` event the server also publishes, so only the reply can close the dock.
  await page.route(/\/api\/session\/ses_request_docks\/permission\/permission-request\/reply/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    replies.push(route.request().postDataJSON())
    await released.promise
    await route.fulfill({ status: 204 })
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  const actions = permission.locator('[data-slot="permission-footer-actions"]')
  await permission.getByRole("button", { name: "Allow once" }).dblclick()
  await expect.poll(() => replies.length).toBe(1)

  for (const name of ["Deny", "Allow always", "Allow once"])
    await expect(actions.getByRole("button", { name, exact: true })).toBeDisabled()

  released.resolve()
  await expect(permission).toHaveCount(0)
  await expect(page.locator('[data-component="composer"]')).toBeVisible()
  await expect(page.getByText("Request failed", { exact: true })).toHaveCount(0)
  expect(replies).toEqual([{ decision: "once" }])
})

test("shows an auto-accepted permission in the dock once its replies stop answering", async ({ page }) => {
  const permissionID = "permission-hung"
  const attempts = { count: 0 }
  await page.clock.install()
  await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [{ id: sessionID, title }],
    sessionPermissions: {
      [sessionID]: [
        { id: permissionID, sessionID, action: "shell", resources: ["git status"], metadata: {}, save: [] },
      ],
    },
    seed: { settings: { permissions: { autoApprove: true } } },
  })
  // Every reply reaches the server and never answers.
  await page.route(new RegExp(`/api/session/${sessionID}/permission/${permissionID}/reply(\\?|$)`), (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    attempts.count++
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')

  // Each reply times out, then the next one starts after its retry delay.
  await expect.poll(() => attempts.count).toBe(1)
  await page.clock.fastForward(15_000)
  await page.clock.fastForward(1_000)
  await expect.poll(() => attempts.count).toBe(2)
  await page.clock.fastForward(15_000)
  await page.clock.fastForward(2_000)
  await expect.poll(() => attempts.count).toBe(3)
  await expect(permission).toHaveCount(0)

  await page.clock.fastForward(15_000)
  await expect(permission.getByText("git status")).toBeVisible()
  expect(attempts.count).toBe(3)
})

test("keeps a typed MCP elicitation answer across a session switch and submits it once", async ({ page }) => {
  const other = { id: "ses_request_docks_other", title: "Other request session" }

  const form = {
    id: "frm_mcp_draft",
    sessionID,
    title: "Deploy",
    metadata: { kind: "mcp-elicitation", server: "release" },
    fields: [{ key: "env", type: "string", title: "Environment" }],
  }

  const replies: unknown[] = []
  await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [{ id: sessionID, title }, other],
    forms: () => (replies.length > 0 ? [] : [form]),
    onFormReply: (reply) => replies.push(reply.body),
    seed: { tabs: [sessionID, other.id] },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = page.locator('[data-component="session-elicitation-dock"]')
  const input = dock.getByRole("textbox", { name: "Environment", exact: true })
  await input.fill("staging")

  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${sessionHref(other.id)}"])`).click()
  await expectSessionTitle(page, other.title)
  await expect(dock).toHaveCount(0)
  await page.locator(`[data-titlebar-tab-slot]:has(a[href="${sessionHref(sessionID)}"])`).click()
  await expectSessionTitle(page, title)
  await expect(input).toHaveValue("staging")

  await dock.getByRole("button", { name: "Submit", exact: true }).dblclick()
  await expect(dock).toHaveCount(0)
  await expect(page.locator('[data-component="composer"]')).toBeVisible()
  expect(replies).toEqual([{ answer: { env: "staging" } }])
})

test("gives a Location elicitation's hung reply back after 30 s and closes it on form.replied", async ({ page }) => {
  const form = {
    id: "frm_mcp_global",
    sessionID: "global",
    title: "Deploy",
    metadata: { kind: "mcp-elicitation", server: "release" },
    fields: [{ key: "env", type: "string", title: "Environment" }],
  }

  const replies: { body: unknown; directory: string | undefined }[] = []
  const transport = await installSseTransport(page, { server: SERVER, retry: 20 })
  await page.clock.install()
  await mockServer(page, { forms: [form] })
  // The server takes the reply and never answers it.
  await page.route(/\/api\/session\/global\/form\/frm_mcp_global\/reply(\?|$)/, (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    replies.push({ body: route.request().postDataJSON(), directory: route.request().headers()["x-opencode-directory"] })
  })

  await page.goto(sessionHref(sessionID))
  await transport.waitForConnection()
  await expectSessionTitle(page, title)
  const dock = page.locator('[data-component="session-elicitation-dock"]')
  const input = dock.getByRole("textbox", { name: "Environment", exact: true })
  const submit = dock.getByRole("button", { name: "Submit", exact: true })
  await input.fill("prod")

  await submit.dblclick()
  await expect.poll(() => replies.length).toBe(1)
  await expect(submit).toBeDisabled()
  expect(replies).toEqual([{ body: { answer: { env: "prod" } }, directory: encodeURIComponent(directory) }])

  await page.clock.fastForward(30_000)
  await expect(submit).toBeEnabled()
  await expect(input).toHaveValue("prod")
  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()

  await transport.send({
    id: "evt_form_replied_global",
    created: 1700000004000,
    type: "form.replied",
    location: { directory },
    data: { sessionID: "global", id: "frm_mcp_global", answer: { env: "prod" } },
  })
  await expect(dock).toHaveCount(0)
  await expect(page.locator('[data-component="composer"]')).toBeVisible()
  expect(replies).toHaveLength(1)
})

test("names the MCP tool, the hook's message and the masked full input in the permission dock", async ({ page }) => {
  const body = "x".repeat(3000)
  const secret = "sk-live-e2e-not-shown"
  await mockServer(page, {
    sessionPermissions: {
      [sessionID]: [
        {
          id: "permission-request",
          sessionID,
          action: "linear_save_comment",
          resources: ["*"],
          save: ["*"],
          metadata: { input: { issueId: "ENG-1", labels: ["bug"], body, apiToken: secret, auth: `Bearer ${secret}` } },
          message: "Posts a comment on a Linear issue",
        },
      ],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)

  const permission = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
  // The fork renders arguments through the masked ReviewApproval.display JSON, not upstream's plain key: value list.
  const input = permission.locator("pre")
  const scroller = input.locator("xpath=..")
  await expect(permission.getByText("linear_save_comment")).toBeVisible()
  await expect(permission.getByText("Posts a comment on a Linear issue")).toBeVisible()
  await expect(input).toContainText('"issueId": "ENG-1"')
  await expect(input).toContainText('"labels": [')
  await expect(input).toContainText('"bug"')
  await expect(input).toContainText('"apiToken": "[REDACTED]"')
  await expect(input).toContainText('"auth": "Bearer [REDACTED]"')
  await expect(permission).not.toContainText(secret)
  // The user approves these arguments, so a long one stays whole and scrolls inside the dock instead of being cut
  await expect(input).toContainText(`"body": "${body}"`)
  await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  // "Allow always" saves the wildcard, so its scope stays visible next to this call's input
  await expect(permission.locator('[data-slot="permission-patterns"]').getByText("*", { exact: true })).toBeVisible()
})

test("loads a running subagent's question without polling idle subagents on every update", async ({ page }) => {
  const runningID = "ses_request_running_subagent"
  const idleIDs = Array.from({ length: 20 }, (_, index) => `ses_request_idle_${index}`)

  const workspace = await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [
      { id: sessionID, title },
      { id: runningID, title: "Running subagent", parentID: sessionID },
      ...idleIDs.map((id) => ({ id, title: id, parentID: sessionID })),
    ],
    seed: { tabs: [sessionID] },
    // The mock reports a Session with a pending form as running.
    forms: [
      {
        id: "frm_subagent_question",
        sessionID: runningID,
        title: "Questions",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", title: "Direction", description: "Which way should the subagent go?" }],
      },
    ],
  })

  // Idle subagents whose worktrees were deleted; a failed read is retried on its next sync.
  await page.route(/\/api\/session\/ses_request_idle_\d+\/form$/, (route) =>
    route.fulfill({ status: 404, json: { message: "Location not found" } }),
  )

  const forms: string[] = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname

    if (request.method() === "GET" && path.startsWith("/api/session/") && path.endsWith("/form")) forms.push(path)
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  await expect(
    page.locator('[data-component="dock-prompt"][data-kind="question"]').getByText("Which way should the subagent go?"),
  ).toBeVisible()

  // Every session update used to re-request the forms of the whole subagent tree.
  await workspace.push(
    [...idleIDs, sessionID].map(
      (id, index) =>
        // SAFETY: the fixture event matches the generated OpenCodeEvent shape for its type.
        ({
          id: `evt_request_rename_${index}`,
          created: index + 2,
          type: "session.renamed",
          durable: { aggregateID: id, seq: 1, version: 1 },
          data: { sessionID: id, title: id === sessionID ? "Renamed request docks" : `${id} renamed` },
        }) as OpenCodeEvent,
    ),
  )
  await expect(page.getByRole("heading", { name: "Renamed request docks", exact: true })).toBeVisible()
  expect(forms.toSorted()).toEqual([`/api/session/${runningID}/form`, `/api/session/${sessionID}/form`].toSorted())
})

test("restores the draft caret before typing after a request dock closes", async ({ page }) => {
  const transport = await installSseTransport(page, { server: SERVER, retry: 20 })
  await mockServer(page, { forms: [] })
  await page.goto(sessionHref(sessionID))
  await transport.waitForConnection()
  await expectSessionTitle(page, title)

  const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
  const draft = "keep the caret at the end"

  const caret = () =>
    editor.evaluate((element) => {
      const selection = window.getSelection()

      if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return -1
      const range = selection.getRangeAt(0).cloneRange()
      range.selectNodeContents(element)
      range.setEnd(selection.anchorNode!, selection.anchorOffset)

      return range.toString().length
    })

  await editor.fill(draft)
  // The editor places the caret after the filled text; move it only from that known position.
  await expect.poll(caret).toBe(draft.length)

  for (let index = 0; index < 4; index++) await page.keyboard.press("ArrowLeft")
  const cursor = draft.length - 4
  await expect.poll(caret).toBe(cursor)
  await transport.send({
    id: "evt_form_created",
    created: 1700000001000,
    type: "form.created",
    location: { directory },
    data: {
      form: {
        id: "frm_question_caret",
        sessionID,
        title: "Questions",
        metadata: { kind: "question", tool: { messageID: "message-caret", id: "call-caret" } },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Continue",
            description: "Continue?",
            options: [{ value: "yes", label: "Yes", description: "Continue the session" }],
            custom: true,
          },
        ],
      },
    },
  })
  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(editor).toHaveCount(0)

  await transport.send({
    id: "evt_form_cancelled",
    created: 1700000002000,
    type: "form.cancelled",
    location: { directory },
    data: { sessionID, id: "frm_question_caret" },
  })
  await expect(question).toHaveCount(0)
  await expect(editor).toBeVisible()
  await page.keyboard.press("x")

  await expect(editor).toHaveText(`${draft.slice(0, cursor)}x${draft.slice(cursor)}`)
})

const childID = "ses_request_docks_child"

const otherRootID = "ses_request_docks_other"

// A face leaving the composer morph keeps rendering its last dock, aria-hidden and inert, until its box closes.
const permissionDock = (page: Page) =>
  page
    .locator('[data-slot="composer-face"]:not([aria-hidden="true"])')
    .locator('[data-component="dock-prompt"][data-kind="permission"]')

const permissionReply = (page: Page) =>
  page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/permission/"))

// A current-shape request; `review` makes it a manual model-refusal review.
type PermissionFixture = {
  id?: string
  sessionID?: string
  review?: boolean
  message?: string
  save?: string[]
  resources?: string[]
  metadata?: { action: { identity: string; arguments: { command: string }; cwd: string; complete: boolean } }
}

function permissionRequest(input: PermissionFixture = {}) {
  const { review, ...rest } = input

  const request = {
    id: "per_fixture",
    sessionID,
    action: "shell",
    resources: ["printf harmless"],
    save: [],
    metadata: {
      action: {
        identity: "shell",
        arguments: { command: "printf harmless", token: "secret-fixture" },
        cwd: "/fixture",
        complete: true,
      },
    },
    ...rest,
  }

  if (!review) return request

  return { ...request, review: { kind: "model-refusal", reason: "Synthetic refusal" } }
}

function fulfilError(status: number, body: { _tag: string; message: string; requestID?: string }) {
  return { status, contentType: "application/json", body: JSON.stringify(body) }
}

test("a child request pending before the parent connects is shown and answered for the child only", async ({
  page,
}) => {
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [
      { id: sessionID, title },
      { id: childID, title: "Child", parentID: sessionID },
      { id: otherRootID, title: "Other root" },
    ],
    seed: { tabs: [sessionID] },
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [childID]: [permissionRequest({ sessionID: childID, review: true })],
      [otherRootID]: [permissionRequest({ id: "per_other", sessionID: otherRootID, review: true })],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await expect(dock).toBeVisible()
  await expect(dock).toContainText(`per_fixture · session ${childID}`)
  await expect(dock).not.toContainText("per_other")
  await expect(dock).not.toContainText("secret-fixture")

  const reply = permissionReply(page)
  await dock.getByRole("button", { name: "Approve per_fixture once", exact: true }).click()
  const response = await reply
  expect(new URL(response.url()).pathname).toBe(`/api/session/${childID}/permission/per_fixture/reply`)
  expect(response.request().postDataJSON()).toEqual({ decision: "review_once" })
  await expect(dock).toHaveCount(0)
  expect(replies).toEqual([{ sessionID: childID, permissionID: "per_fixture", body: { decision: "review_once" } }])
})

// Records every read naming another root, which a selected-tree catch-up must never touch. The one exception is the
// connect-time registration of a running Session this client has not loaded (#53012): the mock reports a Session with
// a pending request as running, and that read loads only its info.
function foreignReads(page: Page) {
  const reads: string[] = []
  page.on("request", (request) => {
    const read = `${request.method()} ${new URL(request.url()).pathname}`

    if (request.url().includes(otherRootID) && read !== `GET /api/session/${otherRootID}`) reads.push(read)
  })

  return reads
}

test("a request waiting in a cold grandchild is found from the selected root", async ({ page }) => {
  const grandchildID = "ses_request_docks_grandchild"
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  const reads = foreignReads(page)
  await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [
      { id: sessionID, title },
      { id: childID, title: "Child", parentID: sessionID },
      { id: grandchildID, title: "Grandchild", parentID: childID },
      { id: otherRootID, title: "Other root" },
    ],
    seed: { tabs: [sessionID] },
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [grandchildID]: [permissionRequest({ sessionID: grandchildID, review: true })],
      [otherRootID]: [permissionRequest({ id: "per_other", sessionID: otherRootID, review: true })],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await expect(dock).toContainText(`per_fixture · session ${grandchildID}`)

  const reply = permissionReply(page)
  await dock.getByRole("button", { name: "Approve per_fixture once", exact: true }).click()
  expect(new URL((await reply).url()).pathname).toBe(`/api/session/${grandchildID}/permission/per_fixture/reply`)
  await expect(dock).toHaveCount(0)
  expect(replies).toEqual([{ sessionID: grandchildID, permissionID: "per_fixture", body: { decision: "review_once" } }])
  expect(reads).toEqual([])
})

test("a request waiting in a child beyond the first page of children is found", async ({ page }) => {
  // The mock lists children newest first, 50 to a page, so the first two children are on the second page.
  const children = Array.from({ length: 52 }, (_, index) => ({
    id: `ses_request_docks_page${index}`,
    title: `Child ${index}`,
    parentID: sessionID,
  }))

  const owner = children[0]!.id
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  const reads = foreignReads(page)
  await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [{ id: sessionID, title }, ...children, { id: otherRootID, title: "Other root" }],
    seed: { tabs: [sessionID] },
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [owner]: [permissionRequest({ sessionID: owner, review: true })],
      [otherRootID]: [permissionRequest({ id: "per_other", sessionID: otherRootID, review: true })],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await expect(dock).toContainText(`per_fixture · session ${owner}`)

  const reply = permissionReply(page)
  await dock.getByRole("button", { name: "Approve per_fixture once", exact: true }).click()
  expect(new URL((await reply).url()).pathname).toBe(`/api/session/${owner}/permission/per_fixture/reply`)
  await expect(dock).toHaveCount(0)
  expect(replies).toEqual([{ sessionID: owner, permissionID: "per_fixture", body: { decision: "review_once" } }])
  expect(reads).toEqual([])
})

test("a long manual review scope scrolls inside the dock and keeps its controls reachable", async ({ page }) => {
  const command = "printf harmless\n".repeat(250) + "END_OF_SCOPE"
  await mockServer(page, {
    onPermissionReply: () => {},
    sessionPermissions: {
      [sessionID]: [
        permissionRequest({
          review: true,
          resources: [command],
          metadata: { action: { identity: "shell", arguments: { command }, cwd: "/fixture", complete: true } },
        }),
      ],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await expect(dock.getByText("Synthetic refusal", { exact: true })).toBeInViewport()
  await expect(dock.getByRole("textbox", { name: "I approve per_fixture", exact: true })).toBeInViewport()
  await expect(dock.getByRole("button", { name: "Approve per_fixture once", exact: true })).toBeInViewport()
  await expect(dock.getByRole("button", { name: "Deny", exact: true })).toBeInViewport()
  const scope = dock.getByRole("region", { name: "Requested permission scope" })
  // The complete scope stays inspectable: nothing is cut off, it scrolls.
  await expect(scope).toContainText("END_OF_SCOPE")
  expect(await scope.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await scope.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(scope.getByText(/END_OF_SCOPE/)).toBeInViewport()
})

test("a typed manual approval is kept when the server rejects it and cleared only by success", async ({ page }) => {
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  const posts: unknown[] = []
  await mockServer(page, {
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: { [sessionID]: [permissionRequest({ review: true })] },
  })

  // The first reply is invalid and the second fails on the server; neither consumes the request.
  const failures = [
    fulfilError(400, { _tag: "InvalidRequestError", message: "Fixture permission invalid" }),
    fulfilError(500, { _tag: "InternalError", message: "Fixture server failure" }),
  ]

  await page.route("**/api/session/*/permission/*/reply", (route) => {
    posts.push(route.request().postDataJSON())
    const failure = failures.shift()

    return failure ? route.fulfill(failure) : route.fallback()
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  const input = dock.getByRole("textbox", { name: "I approve per_fixture", exact: true })
  await expect(input).toBeEditable()
  await input.fill("I approve per_wrong")
  await input.press("Enter")
  await expect(dock.getByRole("alert")).toHaveText("Enter the exact approval phrase for this pending request.")
  expect(posts).toEqual([])
  await input.fill("I approve per_fixture")

  // A declared 400 shows the server's message; an undeclared 500 shows the client's status error.
  for (const message of ["Fixture permission invalid", "UnexpectedStatus: 500"]) {
    const reply = permissionReply(page)
    await input.press("Enter")
    await reply
    await expect(page.getByText(message, { exact: true })).toBeVisible()
    await expect(input).toBeEditable()
    await expect(input).toHaveValue("I approve per_fixture")
    await expect(dock).toBeVisible()
  }

  const reply = permissionReply(page)
  await input.press("Enter")
  expect((await reply).status()).toBe(204)
  await expect(dock).toHaveCount(0)
  expect(posts).toEqual([{ decision: "review_once" }, { decision: "review_once" }, { decision: "review_once" }])
  expect(replies).toEqual([{ sessionID, permissionID: "per_fixture", body: { decision: "review_once" } }])
})

test("an expired manual approval reports failure and removes the request without an event", async ({ page }) => {
  const posts: unknown[] = []
  await mockServer(page, {
    onPermissionReply: () => {},
    sessionPermissions: { [sessionID]: [permissionRequest({ review: true })] },
  })
  await page.route("**/api/session/*/permission/*/reply", (route) => {
    posts.push(route.request().postDataJSON())

    return route.fulfill(
      fulfilError(404, {
        _tag: "PermissionNotFoundError",
        requestID: "per_fixture",
        message: "Permission request not found: per_fixture",
      }),
    )
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  const reply = permissionReply(page)
  await dock.getByRole("button", { name: "Approve per_fixture once", exact: true }).click()
  expect((await reply).status()).toBe(404)
  await expect(page.getByText("Permission request not found: per_fixture", { exact: true })).toBeVisible()
  await expect(dock).toHaveCount(0)
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
  expect(posts).toEqual([{ decision: "review_once" }])
})

test("a hung permission reply's own request is aborted at the timeout", async ({ page }) => {
  await page.clock.install()
  await mockServer(page, {
    onPermissionReply: () => {},
    sessionPermissions: { [sessionID]: [permissionRequest()] },
  })
  const held = await holdRoute(page, "**/api/session/*/permission/*/reply", { method: "POST" })

  try {
    await page.goto(sessionHref(sessionID))
    await expectSessionTitle(page, title)
    const dock = permissionDock(page)
    const allow = dock.getByRole("button", { name: "Allow once", exact: true })
    await allow.click()
    const first = await held.arrived
    const failed = page.waitForEvent("requestfailed", { predicate: (request) => request === first, timeout: 10_000 })

    await page.clock.fastForward(15_000)
    // The abandoned attempt's own HTTP request is cancelled, not merely ignored when it lands.
    expect((await failed).failure()?.errorText).toBe("net::ERR_ABORTED")
    await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
    await expect(allow).toBeEnabled()
    expect(held.requests).toHaveLength(1)
  } finally {
    held.release()
  }
})

for (const settled of ["reject", "review_once"] as const) {
  test(`a manual approval in flight when permission.replied (${settled}) arrives closes and cancels its request`, async ({
    page,
  }) => {
    const replies: unknown[] = []

    const mock = await mockServer(page, {
      onPermissionReply: (reply) => replies.push(reply),
      sessionPermissions: { [sessionID]: [permissionRequest({ review: true })] },
    })

    const held = await holdRoute(page, "**/api/session/*/permission/*/reply", { method: "POST" })

    try {
      await page.goto(sessionHref(sessionID))
      await expectSessionTitle(page, title)
      const dock = permissionDock(page)
      await dock.getByRole("button", { name: "Approve per_fixture once", exact: true }).click()
      const request = await held.arrived
      const failed = page.waitForEvent("requestfailed", { predicate: (item) => item === request, timeout: 10_000 })

      // Expiry or another client settles the request first; the dock hides it either way.
      await mock.push([
        {
          id: `evt_reply_${settled}`,
          created: 1700000000002,
          type: "permission.replied",
          location: { directory: mock.directory },
          data: { sessionID, requestID: "per_fixture", reply: settled },
        },
      ])
      await expect(dock).toHaveCount(0)
      expect((await failed).failure()?.errorText).toBe("net::ERR_ABORTED")
      await expect(page.getByText("Request failed", { exact: true })).toHaveCount(0)
      expect(replies).toEqual([])
    } finally {
      held.release()
    }
  })
}

test("ordinary requests show their exact masked scope and offer Allow always only with a save scope", async ({
  page,
}) => {
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  await mockServer(page, {
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [sessionID]: [permissionRequest({ message: "Synthetic ordinary reason", save: ["printf *"] })],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await expect(dock).toContainText(`per_fixture · session ${sessionID} · tool shell`)
  await expect(dock).toContainText("Synthetic ordinary reason")
  const scope = dock.getByRole("region", { name: "Requested permission scope" })
  await expect(scope).toContainText("/fixture")
  await expect(scope).toContainText("printf harmless")
  await expect(scope).toContainText("[REDACTED]")
  await expect(dock).not.toContainText("secret-fixture")
  await expect(dock).toContainText("Allow always saves these patterns for this project:")
  await expect(dock.locator('[data-slot="permission-patterns"]')).toHaveText("printf *")

  const reply = permissionReply(page)
  await dock.getByRole("button", { name: "Allow always", exact: true }).click()
  expect((await reply).request().postDataJSON()).toEqual({ decision: "always" })
  await expect(dock).toHaveCount(0)
  expect(replies).toEqual([{ sessionID, permissionID: "per_fixture", body: { decision: "always" } }])
})

test("on a narrow screen, feedback for a long ordinary subagent request stays usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  const command = "printf harmless\n".repeat(250) + "END_OF_SCOPE"
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [
      { id: sessionID, title },
      { id: childID, title: "Child", parentID: sessionID },
    ],
    seed: { tabs: [sessionID] },
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [childID]: [
        permissionRequest({
          sessionID: childID,
          message: "The fixture asks to run a long harmless command in its own directory. ".repeat(8),
          resources: [command],
          save: Array.from({ length: 30 }, (_, index) => `/fixture/scoped/pattern${index}/*`),
          metadata: { action: { identity: "shell", arguments: { command }, cwd: "/fixture", complete: true } },
        }),
      ],
    },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await dock.getByRole("button", { name: "Deny", exact: true }).click()
  const feedback = dock.getByRole("textbox", { name: "Tell the agent what to do differently (optional)" })
  const confirm = dock.getByRole("button", { name: "Deny with feedback", exact: true })
  await expect(feedback).toBeInViewport({ ratio: 1 })
  await expect(dock.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({ ratio: 1 })
  await expect(confirm).toBeInViewport({ ratio: 1 })

  // A real pointer click: nothing may cover the feedback field.
  await feedback.click()
  await page.keyboard.type("Not on this screen")

  // The whole reason, scope and save patterns stay inspectable by scrolling.
  const scope = dock.getByRole("region", { name: "Requested permission scope" })
  await expect(scope).toContainText("END_OF_SCOPE")
  await expect(scope).toContainText("/fixture/scoped/pattern29/*")
  await scope.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(scope.getByText("/fixture/scoped/pattern29/*", { exact: true })).toBeInViewport()

  const reply = permissionReply(page)
  await confirm.click()
  expect((await reply).request().postDataJSON()).toEqual({ decision: "reject", message: "Not on this screen" })
  await expect(dock).toHaveCount(0)
  expect(replies).toEqual([
    { sessionID: childID, permissionID: "per_fixture", body: { decision: "reject", message: "Not on this screen" } },
  ])
})

test("a manual review never offers Allow always, even with a save scope", async ({ page }) => {
  await mockServer(page, {
    onPermissionReply: () => {},
    sessionPermissions: { [sessionID]: [permissionRequest({ review: true, save: ["printf *"] })] },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await expect(dock.getByRole("button", { name: "Approve per_fixture once", exact: true })).toBeVisible()
  await expect(dock.getByRole("button", { name: "Allow always", exact: true })).toHaveCount(0)
  await expect(dock.locator('[data-slot="permission-patterns"]')).toHaveCount(0)
})

test("denying an ordinary subagent request can carry feedback, while other denials stay immediate", async ({
  page,
}) => {
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []

  const mock = await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [
      { id: sessionID, title },
      { id: childID, title: "Child", parentID: sessionID },
    ],
    seed: { tabs: [sessionID] },
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: { [childID]: [permissionRequest({ sessionID: childID })] },
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const dock = permissionDock(page)
  await dock.getByRole("button", { name: "Deny", exact: true }).click()
  const feedback = dock.getByRole("textbox", { name: "Tell the agent what to do differently (optional)" })
  await feedback.fill("Use the fixture directory instead")
  await dock.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(feedback).toHaveCount(0)
  await expect(dock.getByRole("button", { name: "Allow once", exact: true })).toBeVisible()
  expect(replies).toEqual([])

  await dock.getByRole("button", { name: "Deny", exact: true }).click()
  await feedback.fill("Use the fixture directory instead")
  const rejected = permissionReply(page)
  await dock.getByRole("button", { name: "Deny with feedback", exact: true }).click()
  expect((await rejected).request().postDataJSON()).toEqual({
    decision: "reject",
    message: "Use the fixture directory instead",
  })
  await expect(dock).toHaveCount(0)

  // A root ordinary request and a manual review each deny at once, with no feedback step.
  for (const request of [
    permissionRequest({ id: "per_root" }),
    permissionRequest({ id: "per_review", review: true }),
  ]) {
    await mock.push([
      {
        id: `evt_ask_${request.id}`,
        created: 1700000000001,
        type: "permission.asked",
        location: { directory: mock.directory },
        data: request,
      },
    ])
    await expect(dock).toContainText(`${request.id} · session ${sessionID}`)
    const reply = permissionReply(page)
    await dock.getByRole("button", { name: "Deny", exact: true }).click()
    expect((await reply).request().postDataJSON()).toEqual({ decision: "reject" })
    await expect(dock).toHaveCount(0)
  }

  expect(replies).toEqual([
    {
      sessionID: childID,
      permissionID: "per_fixture",
      body: { decision: "reject", message: "Use the fixture directory instead" },
    },
    { sessionID, permissionID: "per_root", body: { decision: "reject" } },
    { sessionID, permissionID: "per_review", body: { decision: "reject" } },
  ])
})

test("automatic approval answers ordinary requests but never a manual review", async ({ page }) => {
  const replies: { sessionID: string; permissionID: string; body: unknown }[] = []
  await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [{ id: sessionID, title }],
    seed: { settings: { permissions: { autoApprove: true } } },
    onPermissionReply: (reply) => replies.push(reply),
    sessionPermissions: {
      [sessionID]: [permissionRequest({ id: "per_ordinary" }), permissionRequest({ review: true })],
    },
  })

  const automatic = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/permission/per_ordinary/reply"),
  )

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  expect((await automatic).request().postDataJSON()).toEqual({ decision: "once" })
  const dock = permissionDock(page)
  await expect(dock.getByRole("button", { name: "Approve per_fixture once", exact: true })).toBeEnabled()
  expect(replies).toEqual([{ sessionID, permissionID: "per_ordinary", body: { decision: "once" } }])

  const manual = permissionReply(page)
  await dock.getByRole("button", { name: "Approve per_fixture once", exact: true }).click()
  expect((await manual).request().postDataJSON()).toEqual({ decision: "review_once" })
  await expect(dock).toHaveCount(0)
  expect(replies).toHaveLength(2)
})

test("an expired manual review closes from its event and restores the draft without replay", async ({ page }) => {
  const replies: unknown[] = []
  const prompts: unknown[] = []

  const mock = await mockWorkspace(page, {
    name: "RequestDocks",
    directory,
    sessions: [{ id: sessionID, title }],
    onPermissionReply: (reply) => replies.push(reply),
    onPrompt: (prompt) => prompts.push(prompt),
  })

  await page.goto(sessionHref(sessionID))
  await expectSessionTitle(page, title)
  const editor = page.locator('[data-component="composer-editor"][contenteditable="true"]')
  await expect(editor).toBeEditable()
  await editor.fill("Keep my existing draft")
  await mock.push([
    {
      id: "evt_ask_expire",
      created: 1700000000001,
      type: "permission.asked",
      location: { directory: mock.directory },
      data: permissionRequest({ review: true }),
    },
  ])
  await expect(permissionDock(page)).toBeVisible()
  await expect(editor).toHaveCount(0)
  await mock.push([
    {
      id: "evt_reply_expire",
      created: 1700000000002,
      type: "permission.replied",
      location: { directory: mock.directory },
      data: { sessionID, requestID: "per_fixture", reply: "reject" },
    },
  ])
  await expect(permissionDock(page)).toHaveCount(0)
  await expect(editor).toBeEditable()
  await expect(editor).toHaveText("Keep my existing draft")
  expect(replies).toEqual([])
  expect(prompts).toEqual([])
})

function mockServer(page: Page, requests: Pick<WorkspaceInput, "sessionPermissions" | "onPermissionReply" | "forms">) {
  return mockWorkspace(page, { name: "RequestDocks", directory, sessions: [{ id: sessionID, title }], ...requests })
}
