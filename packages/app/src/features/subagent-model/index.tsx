// Shows, in a subagent session's header, which agent and model run it ("Lister · GPT 6.1 Sol (OAuth) · OpenAI · high"),
// as the TUI's bar does. A subagent session has no prompt of its own, so nothing else on screen says this.

import { createMemo, Show } from "solid-js"
import { useData } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"
import { AppExtensions } from "@/extensions/registry"
import { subagentModelLine } from "./model"

AppExtensions.sessionHeaderItem({
  id: "subagent-model",
  order: 100,
  render(ctx) {
    const data = useData()
    const language = useLanguage()
    const line = createMemo(() => {
      const id = ctx.sessionID()
      const session = id ? data.session.get(id) : undefined
      if (!session?.parentID || !session.model) return undefined
      const location = session.location
      return subagentModelLine(session, {
        models: data.location.model.list(location) ?? [],
        providers: data.location.provider.list(location) ?? [],
      })
    })
    return (
      <Show when={line()}>
        {(value) => (
          <div
            class="shrink-0 truncate text-12-regular text-text-weak px-2"
            title={language.t("session.subagentModel.title")}
          >
            {value()}
          </div>
        )}
      </Show>
    )
  },
})
