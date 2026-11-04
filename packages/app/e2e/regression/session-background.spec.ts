import { expect, test, type Page } from "@playwright/test"
import { sessionHref } from "../utils/app"
import { openSession } from "../utils/workspace"

// The fork's Background view: a session's subagents, reachable without Details or Extensions.
const root = { id: "ses_background_root", title: "Month-end accounts" }

const model = { id: "gpt-6.1-sol", providerID: "openai", variant: "high" }

const children = [
  { id: "ses_background_ledger", title: "Reconcile ledger", parentID: root.id, agent: "Cat", model },
  { id: "ses_background_invoices", title: "Check invoices", parentID: root.id, agent: "Skutter", model },
  { id: "ses_background_vat", title: "Draft VAT return", parentID: root.id, agent: "Lister", model },
]

const jobs = [
  { sessionID: children[2].id, agent: "Lister", description: "Draft VAT return", status: "completed" },
  { sessionID: children[0].id, agent: "Cat", description: "Reconcile ledger", status: "running" },
  { sessionID: children[1].id, agent: "Skutter", description: "Check invoices", status: "running" },
]

// A second session with its own work, to check that a switch announces only the routed session's jobs.
const other = { id: "ses_background_other", title: "Payroll" }

const otherChild = { id: "ses_background_payroll", title: "Run payroll", parentID: other.id, agent: "Cat", model }

const otherJobs = [{ sessionID: otherChild.id, agent: "Cat", description: "Run payroll", status: "running" }]

async function open(page: Page, failing = false, tasks = () => ({ [root.id]: jobs })) {
  return openSession(page, {
    name: "Background",
    sessions: [root, ...children, other, otherChild],
    sessionID: root.id,
    seed: { tabs: [root.id, other.id] },
    sessionTasks: tasks,
    sessionTaskFailures: () => failing,
  })
}

const background = (page: Page) => page.locator('[data-slot="session-background-content"]')

test("cold history: saved descendants remain discoverable with an empty task registry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const grandchild = {
    id: "ses_background_receipts",
    title: "Audit receipts",
    parentID: children[0].id,
    agent: "Kryten",
    outcome: "failed",
  }
  await openSession(page, {
    name: "Background history",
    sessions: [
      root,
      { ...children[0], outcome: "succeeded" },
      children[1],
      { ...children[2], outcome: "interrupted" },
      grandchild,
      other,
      otherChild,
      // These old descendants are outside the latest global inventory on a cold route.
      ...Array.from({ length: 205 }, (_, index) => ({ id: `ses_newer_${index}`, title: `Newer ${index}` })),
    ],
    sessionID: root.id,
    seed: { tabs: [root.id, other.id] },
    sessionTasks: () => ({}),
  })

  const pill = page.getByRole("button", { name: "Subagents", exact: true })
  await expect(pill).toBeVisible()
  await expect(pill).not.toContainText("running")
  await pill.click()
  const list = background(page)
  await expect(list.getByRole("status")).toHaveText("1 completed, 1 failed, 1 cancelled, 1 idle")
  await expect(list.getByRole("button", { name: /^(Cat|Skutter|Lister|Kryten)/ })).toHaveCount(4)
  await expect(list.getByRole("button", { name: /^Cat Reconcile ledger/ })).toContainText("Completed")
  await expect(list.getByRole("button", { name: /^Skutter Check invoices/ })).toContainText("Idle")
  const rows = list.getByRole("button", { name: /^(Cat|Skutter|Lister|Kryten)/ })
  await expect(rows).toHaveText([
    /^ListerDraft VAT return.*Cancelled$/,
    /^SkutterCheck invoices.*Idle$/,
    /^CatReconcile ledger.*Completed$/,
    /^KrytenAudit receiptsError$/,
  ])
  // Indentation is the hierarchy contract; it uses logical margins so it also follows text direction.
  await expect(list.getByRole("button", { name: /^Kryten Audit receipts/ }).locator("..")).toHaveCSS(
    "margin-inline-start",
    "16px",
  )
  await expect(list).not.toContainText("Run payroll")
  await expect(list.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)

  await list.getByRole("button", { name: /^Cat Reconcile ledger/ }).click()
  await expect(page).toHaveURL(sessionHref(children[0].id))
  await page.getByRole("button", { name: "Subagents", exact: true }).click()
  await expect(background(page).getByRole("button", { name: /^Kryten Audit receipts/ })).toContainText("Error")
  await expect(background(page).getByRole("button", { name: /^Skutter/ })).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(sessionHref(root.id))
  await expect(background(page).getByRole("button", { name: /^Skutter Check invoices/ })).toContainText("Idle")
  await page.goto(sessionHref(other.id))
  await page.getByRole("button", { name: "Subagents", exact: true }).click()
  await expect(background(page).getByRole("button", { name: /^Cat Run payroll/ })).toContainText("Idle")
  await expect(background(page)).not.toContainText("Reconcile ledger")
})

test("desktop: the running-subagents pill opens the Background tab, whose rows open each subagent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page)

  const pill = page.getByRole("button", { name: "2 subagents running", exact: true })
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAttribute("aria-expanded", "false")
  await expect(page.getByRole("button", { name: "Toggle review", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  await pill.click()

  const list = background(page)
  await expect(list).toBeVisible()
  await expect(pill).toHaveAttribute("aria-expanded", "true")
  const rows = list.getByRole("button", { name: /^(Cat|Skutter|Lister)/ })
  await expect(rows).toHaveText([
    /^CatReconcile ledgergpt-6\.1-sol \(high\)Running$/,
    /^SkutterCheck invoicesgpt-6\.1-sol \(high\)Running$/,
    /^ListerDraft VAT returngpt-6\.1-sol \(high\)Completed$/,
  ])
  await rows.nth(0).click()
  await expect(page).toHaveURL(sessionHref(children[0].id))
})

test("narrow: the Background view lists saved idle subagents without live jobs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, false, () => ({}))

  await page.getByRole("tab", { name: "Background", exact: true }).click()
  const list = background(page)
  await expect(list.getByRole("button", { name: /^Cat/ })).toContainText("Reconcile ledger")
  await expect(list.getByRole("button", { name: /^Lister/ })).toContainText("Idle")
  await expect(page.getByRole("tab", { name: "Background", exact: true })).toHaveText("Background")
})

test("an unreadable job status says so instead of claiming nothing is running", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await open(page, true)

  await page.getByRole("button", { name: "Toggle review", exact: true }).click()
  await page.getByRole("tab", { name: "Background", exact: true }).click()
  const list = background(page)
  await expect(list.getByRole("status")).toHaveText("Background job status is unavailable; retrying automatically.")
  await expect(list).not.toContainText("Nothing is running in the background.")
})

test("job status changes are announced politely, for the routed session only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  let current = jobs
  await open(page, false, () => ({ [root.id]: current, [other.id]: otherJobs }))

  await page.getByRole("button", { name: "2 subagents running", exact: true }).click()
  const status = background(page).getByRole("status")
  await expect(status).toHaveText("2 subagents running, 1 completed")

  // Running jobs finish, fail and are cancelled: the shared poll picks it up and the live region says so.
  current = [jobs[0], { ...jobs[1], status: "error" }, { ...jobs[2], status: "cancelled" }]
  await expect(status).toHaveText("1 completed, 1 failed, 1 cancelled", { timeout: 20_000 })

  // Another session: its own summary, nothing left over from the one it replaced.
  await page.goto(sessionHref(other.id))
  await page.getByRole("button", { name: "1 subagent running", exact: true }).click()
  const next = background(page).getByRole("status")
  await expect(next).toHaveText("1 subagent running")
  await expect(background(page)).not.toContainText("Draft VAT return")
})
