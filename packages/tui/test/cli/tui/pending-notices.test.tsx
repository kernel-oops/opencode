/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import type { SessionMessageAssistant } from "@opencode/client"
import { SessionNoticeRow } from "../../../src/routes/session"
import { useTheme, ThemeProvider } from "../../../src/context/theme"
import { ConfigProvider } from "../../../src/config"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { attemptStatus } from "../../../src/component/prompt/attempt-status"
import { PromptAttemptStatus, PromptInterruptStatus } from "../../../src/component/prompt"

for (const mode of ["light", "dark"] as const) {
  for (const width of [40, 120]) {
    for (const [source, states] of [
      ["subagent", ["completed", "error", "cancelled"]],
      ["shell", ["completed", "error", "cancelled"]],
      ["new_session", ["succeeded", "failed", "interrupted", "unknown"]],
      ["other", ["completed"]],
    ] as const) {
      for (const state of states) {
        test(`${mode} ${width}: ${source} ${state} pending and delivered`, async () => {
          const [pending, setPending] = createSignal(true)
          const visited: string[] = []
          let theme: ReturnType<typeof useTheme>
          const app = await testRender(() => (
            <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}>
              <ThemeProvider mode={mode} source={{ discover: async () => ({}) }}>
                {(() => {
                  theme = useTheme()
                  return <SessionNoticeRow theme={theme} width={width} pending={pending()} onNavigate={(id) => visited.push(id)} message={{
                    type: "synthetic", id: "same-inbox-id", text: "report", description: "A long completion report with details",
                    time: { created: 1 }, metadata: { source, state, childID: "child", agent: "build", launchKey: "launch" },
                  }} />
                })()}
              </ThemeProvider>
            </ConfigProvider></TestTuiContexts>
          ), { width, height: 8 })
          try {
            await app.waitForFrame((frame) => frame.includes("pending delivery"))
            expect(app.captureCharFrame()).toContain("pending delivery")
            const spans = app.renderer.currentRenderBuffer.getSpanLines().flatMap((line) => line.spans).filter((span) => span.text.trim())
            expect(spans.every((span) => (span.attributes & TextAttributes.DIM) !== 0)).toBeTrue()
            expect(spans.every((span) => span.fg.equals(theme!.text.muted))).toBeTrue()
            await app.mockMouse.click(5, 0)
            await app.renderOnce()
            expect(visited).toEqual(source === "subagent" || source === "new_session" ? ["child"] : [])
            expect(app.renderer.currentRenderBuffer.getSpanLines()[0].spans.filter((span) => span.text.trim()).every((span) => span.fg.equals(theme!.text.muted))).toBeTrue()
            setPending(false)
            await app.renderOnce()
            expect(app.captureCharFrame()).not.toContain("pending delivery")
            expect(app.renderer.currentRenderBuffer.getSpanLines().flatMap((line) => line.spans).filter((span) => span.text.trim()).every((span) => !(span.attributes & TextAttributes.DIM))).toBeTrue()
            const outcome = app.renderer.currentRenderBuffer.getSpanLines()[0].spans.find((span) => span.text.trim())!
            if (state === "error" || state === "failed") expect(outcome.fg.equals(theme!.text.feedback.error.base)).toBeTrue()
            if (state === "cancelled" || state === "interrupted") expect(outcome.fg.equals(theme!.text.feedback.warning.base)).toBeTrue()
            if (source === "new_session") {
              expect(app.captureCharFrame()).toContain("Acceptance required")
              expect(app.captureCharFrame()).toContain(state === "unknown" ? "outcome unknown" : state)
            }
          } finally {
            app.renderer.destroy()
          }
        })
      }
    }
  }
}

test("current physical attempt ignores prior failed attempts and logical prompt age", () => {
  const old: SessionMessageAssistant = { type: "assistant", id: "old", agent: "build", model: { id: "model", providerID: "provider" }, content: [], time: { created: 1, completed: 2 } }
  const current: SessionMessageAssistant = { ...old, id: "current", time: { created: 60_000 } }
  expect(attemptStatus(true, [old, current], 780_000)).toBe("Generating · 12m this attempt")
  expect(attemptStatus(false, [current], 780_000)).toBeUndefined()
  expect(attemptStatus(true, [old], 780_000)).toBe("Active")
  expect(attemptStatus(true, [], 780_000)).toBe("Active")
  old.retry = { attempt: 2, at: 3, error: { type: "unknown", message: "Prior attempt" } }
  expect(attemptStatus(true, [old], 780_000)).toBe("Retrying · attempt 2")
  expect(attemptStatus(false, [old], 780_000)).toBeUndefined()
  expect(attemptStatus(true, [old, current], 780_000)).toBe("Generating · 12m this attempt")
  current.retry = { attempt: 3, at: 780_000, error: { type: "unknown", message: "Temporary failure" } }
  expect(attemptStatus(true, [old, current], 780_000)).toBe("Retrying · attempt 3")
  current.retry = undefined
  current.content = [{ type: "tool", id: "tool", name: "shell", state: { status: "running", input: {}, metadata: {} }, time: { created: 60_000 } }]
  expect(attemptStatus(true, [old, current], 780_000)).toBe("Tool running")
})

test.each([40, 120])("attempt footer preserves interrupt hint at %s columns", async (width) => {
  const [label, setLabel] = createSignal<string | undefined>("Generating · 12m this attempt")
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>{(() => {
    const theme = useTheme()
    return <box><PromptAttemptStatus label={label()} subdued={theme.text.muted} /><PromptInterruptStatus armed={false} text={theme.text.base} subdued={theme.text.muted} warning={theme.text.feedback.warning.base} /></box>
  })()}</ThemeProvider></ConfigProvider></TestTuiContexts>, { width, height: 4 })
  try {
    await app.waitForFrame((frame) => frame.includes("Generating"))
    expect(app.captureCharFrame()).toContain("Generating · 12m this attempt")
    expect(app.captureCharFrame()).toContain("esc interrupt")
    setLabel("Retrying · attempt 3")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Retrying · attempt 3")
    setLabel(undefined)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Generating")
    expect(app.captureCharFrame()).not.toContain("Retrying")
    expect(app.captureCharFrame()).toContain("esc interrupt")
  } finally { app.renderer.destroy() }
})
