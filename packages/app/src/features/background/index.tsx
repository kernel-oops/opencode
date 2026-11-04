// The Background feature: a side-panel tab (and narrow-screen view) listing the session's subagents (with
// controls), a pill in the session title row that opens it, and a busy signal
// so a session running a background command shows as working in session lists.
// Registered through the extension registry; the host screens know nothing about it.

import { useLanguage } from "@/runtime/i18n/language"
import { AppExtensions } from "@/extensions/registry"
import { createSessionBackground, SessionBackgroundButton, SessionBackgroundTab } from "./tab"

AppExtensions.panelTab({
  id: "background",
  order: 100,
  title: () => useLanguage().t("session.tab.background"),
  // Next to Review (order 10) in the narrow-screen view switcher.
  mobile: { kind: "tab", order: 15, title: () => useLanguage().t("session.tab.background") },
  create(ctx) {
    const language = useLanguage()
    const background = createSessionBackground(ctx.sessionID)
    return {
      label: () =>
        background.running() > 0
          ? language.plural("session.tab.backgroundCount", background.running())
          : language.t("session.tab.background"),
      content: () => <SessionBackgroundTab background={background} />,
    }
  },
  headerAction(ctx) {
    const background = createSessionBackground(ctx.sessionID)
    return <SessionBackgroundButton background={background} shown={ctx.shown()} onShow={ctx.open} />
  },
})

AppExtensions.sessionBusy({
  id: "background-commands",
  // A background shell OpenCode runs for the session.
  busy: (sessionID, data) => (data.shell?.listBySession?.(sessionID).length ?? 0) > 0,
})
