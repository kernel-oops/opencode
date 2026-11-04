import { Plugin, Slot, type PanelTab } from "@opencode/plugin/gui"
import { BuiltinPanel } from "@opencode/plugin/gui/builtin"
import { AppExtensions, extensionTabID } from "./registry"
import { createMemo, type JSX } from "solid-js"

// Preserve the fork's registered panels through the upstream GUI extension host.
// A tab's header action renders in the session title row; header items and busy checks keep their own host boundaries.
const definition = Plugin.define({})

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  for (const feature of AppExtensions.panelTabs()) {
    const mobile = feature.mobile
    const tab: PanelTab = {
      id: feature.id,
      // Titles are read while rendering, where a feature's title may use context (its language).
      get title() {
        return feature.title?.() ?? feature.id
      },
      pinned: true,
      draggable: false,
      closable: false,
      label: (state) => {
        const contribution = feature.create({ sessionID: () => state.session.id })
        // The upstream host invokes contributions once, untracked. Solid inserts accessor nodes
        // reactively; keep the feature and its cleanup owner stable across count/session changes.
        return createMemo(contribution.label) as unknown as JSX.Element
      },
    }
    ctx.add(BuiltinPanel, {
      id: feature.id,
      region: "side",
      legacy: { [extensionTabID(feature.id)]: feature.id },
      mobile: mobile && {
        order: mobile.order,
        kind: mobile.kind,
        icon: mobile.icon,
        get title() {
          return mobile.title()
        },
      },
      list: () => [tab],
      render: (props) => {
        const contribution = feature.create({ sessionID: () => props.session.id })
        return createMemo(contribution.content) as unknown as JSX.Element
      },
    })
    const headerAction = feature.headerAction
    if (headerAction) {
      const key = `${ctx.id}:${feature.id}`
      ctx.add(Slot, {
        at: "session.header",
        // Before the context usage (10) and details (20) items.
        order: 5,
        render: (input) =>
          headerAction({
            sessionID: () => input.session.id,
            shown: () => ctx.layout.state(key, input.session) === "visible",
            open: () => ctx.layout.open(key, input.session),
          }),
      })
    }
  }
}

export const forkPanels = { ...definition, id: "kernel-oops-panels", windowEntry: () => Promise.resolve({ default: setup }) }
