import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { SPINNER_FRAMES, taskStatusLabel, titlecase } from "./format"
import { runningDescendants, sessionFamily } from "./session"

function wholeMinutes(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return "<1m"
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function SidebarTasks(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const data = props.context.data
  createEffect(() => onCleanup(data.session.task.observe(props.sessionID)))
  let hydration: AbortController | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const controller = new AbortController()
    hydration = controller
    onCleanup(() => controller.abort())
    void data.session.descendants.sync(sessionID, { signal: controller.signal }).catch(() => {})
  })
  const owners = createMemo(() => {
    const sessions = data.session.list()
    return [
      ...sessions.filter((session) => session.id === props.sessionID),
      // Traverse through idle intermediates too: shell ownership outlives agent execution.
      ...runningDescendants(sessions, props.sessionID, () => "running"),
    ]
  })
  const locations = createMemo(() => [
    ...new Map(owners().map((session) => [JSON.stringify(session.location), session.location])).values(),
  ])
  createEffect(() => {
    for (const location of locations()) void data.shell.sync(location).catch(() => {})
  })
  onCleanup(
    data.on("server.connected", () => {
      data.session.descendants.invalidate(props.sessionID)
      void data.session.descendants.sync(props.sessionID, { signal: hydration?.signal }).catch(() => {})
      for (const location of locations()) {
        data.shell.invalidate(location)
        void data.shell.sync(location).catch(() => {})
      }
    }),
  )
  const shells = createMemo(() => {
    const allowed = new Map(owners().map((session) => [session.id, session]))
    return [
      ...new Map(
        locations()
          .flatMap((location) => data.shell.list(location))
          .flatMap((shell) => {
            if (shell.status !== "running" || typeof shell.metadata.sessionID !== "string") return []
            const owner = allowed.get(shell.metadata.sessionID)
            return owner ? [[shell.id, { shell, owner }] as const] : []
          }),
      ).values(),
    ]
  })
  // Shares the data service's one observation with the prompt controls and other views.
  const snapshot = createMemo(() => data.session.task.get(props.sessionID))
  const tracked = createMemo(() => snapshot()?.background ?? [])
  // The parent tracks only the jobs it started itself. A child it did not (woken by a message, resumed by recovery
  // after a restart) still runs, so list running descendants too, and show a tracked entry as running when its
  // session is: an old "completed" job says nothing about a session that has since been woken again.
  // Shell rows show whole elapsed minutes, so re-render once a minute.
  const [tick, setTick] = createSignal(Date.now())
  const timer = setInterval(() => setTick(Date.now()), 60_000)
  onCleanup(() => clearInterval(timer))
  // A plain frame counter rather than <Spinner>, which needs the app's theme and config contexts (a slot plugin gets
  // its theme from its context instead). It only ticks while something is running.
  const [frame, setFrame] = createSignal(0)
  const spin = setInterval(() => {
    if (running() > 0 || shells().length > 0) setFrame((value) => value + 1)
  }, 80)
  onCleanup(() => clearInterval(spin))
  const list = createMemo(() => {
    const jobs = new Map(tracked().map((task) => [task.sessionID, task]))
    const sessions = owners()
    const known = new Set(sessions.map((session) => session.id))
    const nodes = sessions.map((session) => {
      const job = jobs.get(session.id)
      return {
        id: session.id,
        parentID: session.parentID,
        sessionID: session.id,
        agent: job?.agent ?? (session.agent ? titlecase(session.agent) : "Subagent"),
        description: job?.description ?? session.title,
        status: data.session.status(session.id) === "running" ? "running" : (job?.status ?? "idle"),
      }
    })
    // A tracked job can arrive before its session metadata; keep it navigable until hydration catches up.
    nodes.push(
      ...tracked()
        .filter((task) => !known.has(task.sessionID))
        .map((task) => ({
          ...task,
          id: task.sessionID,
          parentID: props.sessionID,
          status: data.session.status(task.sessionID) === "running" ? "running" : task.status,
        })),
    )
    if (!known.has(props.sessionID))
      nodes.push({
        id: props.sessionID,
        parentID: undefined,
        sessionID: props.sessionID,
        agent: "",
        description: "",
        status: "idle",
      })
    return sessionFamily(nodes, props.sessionID, (node) => jobs.has(node.id) || node.status === "running").map(
      ({ session, prefix }) => ({ ...session, prefix }),
    )
  })
  const running = createMemo(() => list().filter((task) => task.status === "running").length)

  const dot = (status: string) => {
    if (status === "running") return theme.text.feedback.warning.base
    if (status === "error") return theme.text.feedback.error.base
    if (status === "completed") return theme.text.feedback.success.base
    return theme.text.muted
  }

  return (
    <Show when={list().length > 0 || shells().length > 0}>
      <box gap={1}>
        <Show when={shells().length > 0}>
          <box>
            <text fg={theme.text.base}>
              <b>Shell commands</b> ({shells().length} running)
            </text>
            <For each={shells()}>
              {({ shell, owner }) => (
                <box minWidth={0}>
                  <box flexDirection="row" gap={1} minWidth={0}>
                    <text flexShrink={0} fg={theme.text.feedback.warning.base}>
                      {SPINNER_FRAMES[frame() % SPINNER_FRAMES.length]}
                    </text>
                    <text
                      fg={theme.text.base}
                      wrapMode="none"
                      truncate
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      // Start at zero so intrinsic command width cannot crowd out elapsed time.
                      width={0}
                      height={1}
                    >
                      {shell.command
                        .split(/[\r\n]/)
                        .find((line) => line.trim())
                        ?.replace(/[\x00-\x20\x7f-\x9f]+/g, " ")
                        .trim()
                        .slice(0, 160) || "Shell command"}
                    </text>
                    <text
                      fg={theme.text.muted}
                      flexShrink={0}
                      minWidth={wholeMinutes(tick() - shell.time.started).length}
                    >
                      {wholeMinutes(tick() - shell.time.started)}
                    </text>
                  </box>
                  <text
                    id={`sidebar.shell.owner.${shell.id}`}
                    fg={theme.text.base}
                    wrapMode="none"
                    truncate
                    onMouseUp={() => props.context.ui.router.navigate({ type: "session", sessionID: owner.id })}
                  >
                    Owner: {owner.agent ? titlecase(owner.agent) : "Session"} · {owner.title}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <Show when={list().length > 0}>
          <box>
            <text fg={theme.text.base}>
              <b>Subagents</b>
              <Show when={running() > 0}>
                <span style={{ fg: theme.text.muted }}> ({running()} running)</span>
              </Show>
            </text>
            <For each={list()}>
              {(task) => (
                <box
                  flexDirection="row"
                  gap={1}
                  minWidth={0}
                  // On release, not press: navigating on press left the release to land on the opened session's
                  // messages, which opened their "Message actions" menu straight away.
                  onMouseUp={() => props.context.ui.router.navigate({ type: "session", sessionID: task.sessionID })}
                >
                  <Show when={task.prefix}>
                    <text fg={theme.text.muted} flexShrink={0}>
                      {task.prefix.trimEnd().replaceAll("─", "")}
                    </text>
                  </Show>
                  <Show
                    when={task.status === "running"}
                    fallback={
                      <text flexShrink={0} style={{ fg: dot(task.status) }}>
                        •
                      </text>
                    }
                  >
                    <text flexShrink={0} style={{ fg: theme.text.feedback.warning.base }}>
                      {SPINNER_FRAMES[frame() % SPINNER_FRAMES.length]}
                    </text>
                  </Show>
                  <text fg={theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                    <b>{task.agent}</b> {task.description}
                  </text>
                  {/* The spinner and the dot already say running or finished; only a state they cannot show gets a label. */}
                  <Show when={task.status !== "running" && task.status !== "completed"}>
                    <text
                      fg={task.status === "error" ? theme.text.feedback.error.base : theme.text.muted}
                      wrapMode="none"
                      flexShrink={0}
                    >
                      {taskStatusLabel(task.status)}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.tasks",
  setup(context) {
    if (
      typeof context.data.session.descendants?.sync !== "function" ||
      typeof context.data.session.descendants?.invalidate !== "function" ||
      typeof context.data.session.task?.get !== "function" ||
      typeof context.data.session.task?.sync !== "function" ||
      typeof context.data.session.task?.observe !== "function"
    ) {
      context.ui.toast.show({ message: "Background tasks require this fork's descendants and shared task-data capabilities.", variant: "warning" })
      return
    }
    return context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarTasks context={context} sessionID={props.sessionID} />,
    })
  },
})
