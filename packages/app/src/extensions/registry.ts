// Extension points for app features that live outside the core screens (src/features/*). A feature registers what it
// adds here once, at import; the host screens render whatever is registered and know nothing about the features
// themselves. Kept deliberately small: a side-panel tab, a session header item, and a "this session is busy" signal.
// Each could later be backed by a real plugin loader without the host screens changing.

import { createSignal, type Accessor, type JSX } from "solid-js"
import type { MobileView } from "@opencode/plugin/gui"

/** Tab ids of extension tabs carry this prefix, so the session's tab state treats them as fixed (not file) tabs. */
export const EXTENSION_TAB_PREFIX = "ext:"
export const extensionTabID = (id: string) => `${EXTENSION_TAB_PREFIX}${id}`
export const isExtensionTab = (tab: string | undefined) => !!tab && tab.startsWith(EXTENSION_TAB_PREFIX)

export interface SessionContext {
  /** The session the screen shows. */
  sessionID: Accessor<string | undefined>
}

/** A tab in the session side panel. `create` runs inside the panel's reactive owner, once per panel. */
export interface PanelTabExtension {
  id: string
  order?: number
  /** The tab's accessible title; read while rendering, so it may use context. Defaults to the id. */
  title?: () => string
  /** A narrow-screen view of the tab, in the session's view switcher (`tab`) or its More drawer. */
  mobile?: Omit<MobileView, "title"> & { title: () => string }
  /**
   * A control in the session's title row that shows the tab: `open` selects it and opens the side panel (on narrow
   * screens, its mobile view); `shown` says it is selected and on screen. Runs once per header, inside its owner.
   */
  headerAction?(ctx: SessionContext & { shown: Accessor<boolean>; open: () => void }): JSX.Element
  create(ctx: SessionContext): { label: () => JSX.Element; content: () => JSX.Element }
}

/** An item rendered at the end of the session header (for example the agent and model of a subagent session). */
export interface SessionHeaderExtension {
  id: string
  order?: number
  render(ctx: SessionContext): JSX.Element
}

/** Store access a busy check may use: the shared client data store, typed structurally. */
export interface BusyData {
  session: { get(id: string): { metadata?: unknown } | undefined }
  shell?: { listBySession?(id: string): readonly unknown[] }
}

/** Says a session is doing work OpenCode's own status does not show (a background command, say). */
export interface SessionBusyExtension {
  id: string
  busy(sessionID: string, data: BusyData, now: number): boolean
}

function collection<T extends { id: string; order?: number }>() {
  const [items, setItems] = createSignal<readonly T[]>([])
  return {
    register(item: T) {
      setItems((current) =>
        [...current.filter((existing) => existing.id !== item.id), item].sort(
          (a, b) => (a.order ?? 0) - (b.order ?? 0),
        ),
      )
      return () => setItems((current) => current.filter((existing) => existing !== item))
    },
    list: items,
  }
}

const panelTabs = collection<PanelTabExtension>()
const sessionHeader = collection<SessionHeaderExtension>()
const sessionBusy = collection<SessionBusyExtension & { order?: number }>()

export const AppExtensions = {
  panelTab: panelTabs.register,
  panelTabs: panelTabs.list,
  sessionHeaderItem: sessionHeader.register,
  sessionHeaderItems: sessionHeader.list,
  sessionBusy: sessionBusy.register,
  /** True when any registered extension says the session is busy. */
  isBusy(sessionID: string, data: BusyData, now = Date.now()) {
    return sessionBusy.list().some((item) => {
      try {
        return item.busy(sessionID, data, now)
      } catch {
        return false
      }
    })
  },
}
