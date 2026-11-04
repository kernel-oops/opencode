import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import type { SessionTaskBackground } from "@opencode/client"
import { Spinner } from "@opencode/ui/spinner"
import { ScrollView } from "@opencode/ui/scroll-view"
import { useData, useServer } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { sessionHref } from "@/shell/routes/session"
import { descendants, shortModelLabel } from "./model"

export interface BackgroundSubagent {
  sessionID: string
  agent: string
  description: string
  model?: string
  status: SessionTaskBackground["status"] | "idle"
  depth: number
}

/**
 * The session's tracked subagent jobs and saved descendants. Shared by the tab label (its count) and the tab.
 */
export function createSessionBackground(sessionID: () => string | undefined) {
  const data = useData()
  const serverSDK = useServerSDK()

  // Job status comes from the shared observer: every view of a session shares one poll, which retries after a failure.
  // `settled` marks the first read for the routed session; a stale session's read is ignored.
  const [load, setLoad] = createStore({ settled: false })
  let reads = 0
  createEffect(() => {
    const id = sessionID()
    if (!id) return
    onCleanup(data.session.task.observe(id))
    const read = ++reads
    setLoad("settled", false)
    void data.session.task.sync(id).then(() => {
      if (read === reads) setLoad("settled", true)
    })
  })
  const snapshot = createMemo(() => {
    const id = sessionID()
    return id ? data.session.task.get(id) : undefined
  })
  /** Loading until the first read settles; unavailable while the status cannot be read (it keeps retrying). */
  const phase = createMemo(() => {
    if (snapshot()) return "ready"
    return load.settled ? "unavailable" : "loading"
  })

  const subagents = createMemo<BackgroundSubagent[]>(() => {
    const id = sessionID()
    if (!id) return []
    const sessions = data.session.list()
    const model = (child: string) => shortModelLabel(data.session.get(child)?.model)
    const running = (child: string) => data.session.status(child) === "running"
    const tracked = (snapshot()?.background ?? []).map((job) => ({
      id: job.sessionID,
      parentID: data.session.get(job.sessionID)?.parentID ?? id,
      sessionID: job.sessionID,
      agent: job.agent,
      description: job.description,
      model: model(job.sessionID),
      status: running(job.sessionID) ? ("running" as const) : job.status,
    }))
    const known = new Set(tracked.map((job) => job.sessionID))
    // The session composer already hydrates this tree through session.descendants.sync, including cold history.
    // An absent live job is not evidence of completion: only a durable outcome can supply a terminal status.
    const untracked = descendants(sessions, id)
      .filter(({ session }) => !known.has(session.id))
      .map(({ session }) => ({
        id: session.id,
        parentID: session.parentID,
        sessionID: session.id,
        agent: session.agent ?? "",
        description: session.title ?? session.id,
        model: shortModelLabel(session.model),
        status: running(session.id)
          ? ("running" as const)
          : session.outcome === "succeeded"
            ? ("completed" as const)
            : session.outcome === "failed"
              ? ("error" as const)
              : session.outcome === "interrupted"
                ? ("cancelled" as const)
                : ("idle" as const),
      }))
    // Running siblings first, never ahead of their owner. Metadata-less tracked jobs stay at the top level.
    return descendants(
      [...tracked, ...untracked].toSorted((a, b) => Number(b.status === "running") - Number(a.status === "running")),
      id,
    ).map(({ session, depth }) => ({ ...session, depth }))
  })

  const running = createMemo(() => subagents().filter((item) => item.status === "running").length)

  // Controls, through the same server endpoints as the TUI's task controls. Each refreshes the status afterwards.
  const after = (work: Promise<unknown>) =>
    work.finally(() => {
      const id = sessionID()
      if (id) return data.session.task.sync(id)
    })
  const controls = {
    paused: () => !!snapshot()?.paused,
    /** Stops one subagent's run (its job then ends). */
    stop: (child: string) => after(serverSDK.api.session.interrupt({ sessionID: child })),
    /** Stops this session's response and pauses automatic continuation; background work keeps running. */
    pause: () => {
      const id = sessionID()
      return id ? after(serverSDK.api.session.task.stopResponse({ sessionID: id })) : Promise.resolve()
    },
    resume: () => {
      const id = sessionID()
      return id ? after(serverSDK.api.session.task.resume({ sessionID: id })) : Promise.resolve()
    },
    /** Stops the response and cancels every background subagent of this session. */
    stopAll: () => {
      const id = sessionID()
      return id ? after(serverSDK.api.session.task.stopAll({ sessionID: id })) : Promise.resolve()
    },
  }

  return { phase, subagents, running, controls }
}

export type SessionBackground = ReturnType<typeof createSessionBackground>

export function SessionBackgroundTab(props: { background: SessionBackground }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const server = useServer()
  // Destructive controls ask once more: the first click arms them for a few seconds, the second acts.
  const [armed, setArmed] = createSignal<string>()
  let disarm: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(disarm))
  const confirmThen = (key: string, action: () => Promise<unknown>) => {
    if (armed() !== key) {
      setArmed(key)
      clearTimeout(disarm)
      disarm = setTimeout(() => setArmed(undefined), 4_000)
      return
    }
    setArmed(undefined)
    void action().catch(() => undefined)
  }
  const controls = () => props.background.controls
  const listed = () => props.background.subagents().length > 0
  const anyRunning = () => props.background.subagents().some((item) => item.status === "running")

  // What the live region announces once the list is readable: counts by status, so a job finishing, failing or being
  // cancelled is announced.
  const summary = createMemo(() => {
    const items = props.background.subagents()
    const count = (status: BackgroundSubagent["status"]) => items.filter((item) => item.status === status).length

    return language.backgroundSummary({
      running: count("running"),
      completed: count("completed"),
      error: count("error"),
      cancelled: count("cancelled"),
      idle: count("idle"),
    })
  })

  const status = (value: BackgroundSubagent["status"]) => language.t(`session.backgroundTab.status.${value}`)

  return (
    <ScrollView class="h-full">
      <div data-slot="session-background-content" class="px-4 pt-4 pb-6 flex flex-col gap-6 md:px-6">
        {/* One polite live region for the list's state, so loading, failure, recovery and job status changes are
          announced. A readable list's summary is for assistive technology only: the rows show it. */}
        <div
          role="status"
          aria-live="polite"
          class="text-14-regular text-text-weak empty:hidden"
          classList={{ "sr-only": listed() && props.background.phase() === "ready" }}
        >
          <Switch>
            <Match when={props.background.phase() === "unavailable"}>
              {language.t("session.backgroundTab.unavailable")}
            </Match>
            <Match when={!listed() && props.background.phase() === "loading"}>
              {language.t("session.backgroundTab.loading")}
            </Match>
            <Match when={!listed()}>{language.t("session.backgroundTab.empty")}</Match>
            <Match when={props.background.phase() === "ready"}>{summary()}</Match>
          </Switch>
        </div>
        <Show when={listed()}>
          <Show when={props.background.subagents().length > 0}>
            <section class="flex flex-col gap-1">
              <div class="flex items-center justify-between gap-2">
                <h3 class="text-12-medium text-text-weak uppercase">{language.t("session.backgroundTab.subagents")}</h3>
                <div class="flex items-center gap-1">
                  <Show
                    when={controls().paused()}
                    fallback={
                      <button
                        type="button"
                        class="text-12-regular text-text-weak hover:text-text-base rounded px-1.5 h-6 hover:bg-surface-raised-base-hover"
                        title={language.t("session.backgroundTab.pauseHint")}
                        onClick={() =>
                          void controls()
                            .pause()
                            .catch(() => undefined)
                        }
                      >
                        {language.t("session.backgroundTab.pause")}
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="text-12-regular text-text-base rounded px-1.5 h-6 hover:bg-surface-raised-base-hover"
                      onClick={() =>
                        void controls()
                          .resume()
                          .catch(() => undefined)
                      }
                    >
                      {language.t("session.backgroundTab.resume")}
                    </button>
                  </Show>
                  <Show when={anyRunning()}>
                    <button
                      type="button"
                      class="text-12-regular rounded px-1.5 h-6 hover:bg-surface-raised-base-hover"
                      classList={{ "text-text-critical-base": armed() === "all", "text-text-weak": armed() !== "all" }}
                      title={language.t("session.backgroundTab.stopAllHint")}
                      onClick={() => confirmThen("all", () => controls().stopAll())}
                    >
                      {armed() === "all"
                        ? language.t("session.backgroundTab.confirmStopAll")
                        : language.t("session.backgroundTab.stopAll")}
                    </button>
                  </Show>
                </div>
              </div>
              <For each={props.background.subagents()}>
                {(item) => (
                  <div
                    class="flex items-center gap-1 min-w-0"
                    style={{ "margin-inline-start": `${item.depth * 16}px` }}
                  >
                    <button
                      type="button"
                      class="flex flex-1 items-center gap-2 min-w-0 rounded-md px-2 h-8 text-left hover:bg-surface-raised-base-hover"
                      onClick={() => navigate(sessionHref(server.key, item.sessionID))}
                    >
                      <span class="shrink-0 size-4 flex items-center justify-center" aria-hidden="true">
                        <Show
                          when={item.status === "running"}
                          fallback={
                            <span
                              class="size-1.5 rounded-full"
                              classList={{
                                "bg-icon-success-base": item.status === "completed",
                                "bg-icon-critical-base": item.status === "error",
                                "bg-icon-weak-base": item.status === "cancelled" || item.status === "idle",
                              }}
                            />
                          }
                        >
                          <Spinner class="size-4" />
                        </Show>
                      </span>
                      <span class="text-14-medium shrink-0">{item.agent}</span>
                      <span class="text-14-regular text-text-base truncate min-w-0 flex-1">{item.description}</span>
                      <Show when={item.model}>
                        <span class="text-12-regular text-text-weak shrink-0">{item.model}</span>
                      </Show>
                      <span
                        class="text-12-regular text-text-weak shrink-0"
                        classList={{ "sr-only": item.status === "running" }}
                      >
                        {status(item.status)}
                      </span>
                    </button>
                    <Show when={item.status === "running"}>
                      <button
                        type="button"
                        class="text-12-regular rounded px-1.5 h-6 shrink-0 hover:bg-surface-raised-base-hover"
                        classList={{
                          "text-text-critical-base": armed() === `stop:${item.sessionID}`,
                          "text-text-weak": armed() !== `stop:${item.sessionID}`,
                        }}
                        onClick={() => confirmThen(`stop:${item.sessionID}`, () => controls().stop(item.sessionID))}
                      >
                        {armed() === `stop:${item.sessionID}`
                          ? language.t("session.backgroundTab.confirmStop")
                          : language.t("session.backgroundTab.stop")}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </section>
          </Show>
        </Show>
      </div>
    </ScrollView>
  )
}

/**
 * The session title row's pill: what is running in the background, one click from the Background tab. Shown while
 * the session has any subagents to list.
 */
export function SessionBackgroundButton(props: { background: SessionBackground; shown: boolean; onShow: () => void }) {
  const language = useLanguage()
  const subagents = () => props.background.subagents().filter((item) => item.status === "running").length
  const label = () => {
    if (subagents() > 0) return language.plural("session.backgroundButton.running", subagents())
    return language.t("session.backgroundTab.subagents")
  }

  return (
    <Show when={props.background.subagents().length > 0}>
      <button
        type="button"
        data-slot="session-background-button"
        class="flex h-8 min-w-0 max-w-56 shrink items-center gap-1.5 rounded-full border border-v2-border-border-base bg-v2-background-bg-base px-3 text-13-medium leading-[var(--line-height-compact)] text-v2-text-text-base hover:bg-[var(--v2-overlay-simple-overlay-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus"
        title={language.t("session.backgroundButton.hint")}
        aria-controls="review-panel"
        aria-expanded={props.shown}
        onClick={() => props.onShow()}
      >
        <Show when={props.background.running() > 0}>
          <Spinner class="size-4 shrink-0" aria-hidden="true" />
        </Show>
        <span class="truncate">{label()}</span>
      </button>
    </Show>
  )
}
