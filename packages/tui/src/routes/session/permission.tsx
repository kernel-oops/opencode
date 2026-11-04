import { createStore } from "solid-js/store"
import { createEffect, createMemo, For, Match, on, Show, Switch } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useTheme, useThemes } from "../../context/theme"
import type { PermissionReply, PermissionRequest } from "@opencode/client"
import { SplitBorder } from "../../ui/border"
import { useData } from "../../context/data"
import { filetype } from "../../util/filetype"
import {
  collapsePermissionLines,
  permissionAlwaysLines,
  permissionOptionLabel,
  permissionPresentation,
} from "../../util/permission"
import { getScrollAcceleration } from "../../util/scroll"
import { useConfig, useCursorStyle } from "../../config"
import { Keymap } from "../../context/keymap"
import { useInteractivity } from "../../context/interactivity"
import { usePathFormatter } from "../../context/path-format"
import { SimulationSemantics } from "../../simulation/semantics"
import { PatchDiff } from "../../component/patch-diff"
import { useToast } from "../../ui/toast"
import { ReviewApproval } from "@opencode/util/bound/review-approval"

type PermissionStage = "permission" | "reject"

function EditBody(props: { file?: string; diff?: string; patch?: string }) {
  const theme = useTheme()
  const themes = useThemes()
  const syntax = themes.currentSyntax
  const config = useConfig().data
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => props.file ?? "")
  const diff = createMemo(() => props.diff ?? "")

  const view = createMemo(() => {
    const diffView = config.diffs?.view
    if (diffView === "unified") return "unified"
    if (diffView === "split") return "split"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background.base,
              foregroundColor: theme.scrollbar.base,
            },
          }}
        >
          <PatchDiff
            diff={diff()}
            hunkFg={theme.diff.text.hunkHeader}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={theme.text.base}
            addedBg={theme.diff.background.added}
            removedBg={theme.diff.background.removed}
            contextBg={theme.diff.background.context}
            addedSignColor={theme.diff.highlight.added}
            removedSignColor={theme.diff.highlight.removed}
            lineNumberFg={theme.diff.lineNumber.text}
            lineNumberBg={theme.diff.background.context}
            addedLineNumberBg={theme.diff.lineNumber.background.added}
            removedLineNumberBg={theme.diff.lineNumber.background.removed}
          />
        </scrollbox>
      </Show>
      <Show when={!diff()}>
        <Show
          when={props.patch}
          fallback={
            <box paddingLeft={1}>
              <text fg={theme.text.muted}>No diff provided</text>
            </box>
          }
        >
          {(patch) => (
            <scrollbox
              height="100%"
              scrollAcceleration={scrollAcceleration()}
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: theme.background.base,
                  foregroundColor: theme.scrollbar.base,
                },
              }}
            >
              <code
                filetype="diff"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={syntax()}
                content={patch()}
                fg={theme.text.muted}
              />
            </scrollbox>
          )}
        </Show>
      </Show>
    </box>
  )
}

// Rows available to the body of a collapsed prompt (maxHeight 15 less padding, header and footer), and the
// columns it loses to the border and padding.
const COLLAPSED_BODY_ROWS = 8
const BODY_INSET_COLUMNS = 8

export function PermissionPrompt(props: { request: PermissionRequest; directory?: string }) {
  const data = useData()
  const dimensions = useTerminalDimensions()
  const shortcuts = Keymap.useShortcuts()
  const toast = useToast()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })
  const pathFormatter = usePathFormatter()
  const session = createMemo(() => data.session.get(props.request.sessionID))

  const source = createMemo(() => {
    const tool = props.request.source
    if (!tool) return { input: undefined, metadata: undefined }
    const message = data.session.message.get(props.request.sessionID, tool.messageID)
    if (message?.type !== "assistant") return { input: undefined, metadata: undefined }
    const part = message.content.find((part) => part.type === "tool" && part.id === tool.id)
    if (part?.type === "tool" && part.state.status !== "streaming") {
      return { input: part.state.input, metadata: part.state.metadata }
    }
    return { input: undefined, metadata: undefined }
  })

  const theme = useTheme()

  function reply(value: PermissionReply, message?: string) {
    return data.session.permission
      .reply({ sessionID: props.request.sessionID, requestID: props.request.id, decision: value, message })
      .catch((error: unknown) => toast.error(error))
  }

  return (
    <Switch>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          action={props.request.action}
          instance={props.request.id}
          onConfirm={(message) => {
            reply("reject", message || undefined)
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission" && props.request.review}>
        <ManualReviewPrompt request={props.request} onReply={reply} />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const current = permissionPresentation(
            {
              action: props.request.action,
              resources: props.request.resources,
              metadata: props.request.metadata,
              input: source().input,
              toolMetadata: source().metadata,
            },
            pathFormatter.format,
          )
          const presentationBody = (expanded: boolean) =>
            props.request.action === "edit" ? (
              <EditBody file={current.file} diff={current.diff} patch={current.patch} />
            ) : props.request.action === "external_directory" ? (
              <Show when={current.lines.length > 0}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.text.muted}>Patterns</text>
                  <box>
                    <For each={current.lines}>{(line) => <text fg={theme.text.base}>{line}</text>}</For>
                  </box>
                </box>
              </Show>
            ) : (
              (() => {
                // Collapsed, a long command is cut to what fits and says how much is hidden rather than
                // clipping silently; the fullscreen view shows it all.
                const fitted = expanded
                  ? { lines: current.lines, hidden: 0 }
                  : collapsePermissionLines(current.lines, dimensions().width - BODY_INSET_COLUMNS, COLLAPSED_BODY_ROWS)
                return (
                  <box paddingLeft={1}>
                    <For each={fitted.lines}>
                      {(line) => (
                        <text
                          fg={
                            props.request.action === "shell" ||
                            props.request.action === "subagent" ||
                            props.request.action === "task"
                              ? theme.text.base
                              : theme.text.muted
                          }
                        >
                          {line}
                        </text>
                      )}
                    </For>
                    <Show when={fitted.hidden > 0}>
                      <text fg={theme.text.muted}>
                        {`… ${fitted.hidden} more line${fitted.hidden === 1 ? "" : "s"} · ${shortcuts.get("permission.prompt.fullscreen")} to view all`}
                      </text>
                    </Show>
                  </box>
                )
              })()
            )

          const header = () => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={theme.text.feedback.warning.base}>{"△"}</text>
                <text fg={theme.text.base}>Permission required</text>
              </box>
              <Show when={props.request.action !== "shell" && current.title}>
                <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
                  <text fg={theme.text.muted} flexShrink={0}>
                    {current.icon}
                  </text>
                  <text fg={theme.text.base}>{current.title}</text>
                </box>
              </Show>
            </box>
          )

          const body = (
            <SessionQuestion
              title="Permission required"
              semanticLabel={permissionSemanticLabel(props.request.action, current.title)}
              instance={props.request.id}
              header={header()}
              body={(option, view) => (
                <Show when={option === "always"} fallback={presentationBody(view.expanded)}>
                  <box paddingLeft={1} gap={1}>
                    <For each={permissionAlwaysLines(props.request)}>
                      {(line, index) => <text fg={index() === 0 ? theme.text.muted : theme.text.base}>{line}</text>}
                    </For>
                  </box>
                </Show>
              )}
              options={
                props.request.save?.length
                  ? {
                      once: permissionOptionLabel("once"),
                      always: permissionOptionLabel("always"),
                      reject: permissionOptionLabel("reject"),
                    }
                  : { once: permissionOptionLabel("once"), reject: permissionOptionLabel("reject") }
              }
              escapeKey="reject"
              fullscreen
              onSelect={(option) => {
                if (option === "always") {
                  reply("always")
                  return
                }
                if (option === "reject") {
                  if (session()?.parentID) {
                    setStore("stage", "reject")
                    return
                  }
                  reply("reject")
                  return
                }
                reply("once")
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

export function permissionSemanticLabel(action: string, title?: string) {
  return `Permission required: ${title ?? action}`
}

// Keyboard stops in Tab order. Focus starts on "reject" so a stray Enter can never approve.
const REVIEW_FOCUS = ["reject", "approve", "input"] as const

function ManualReviewPrompt(props: { request: PermissionRequest; onReply: (value: PermissionReply) => Promise<void> }) {
  const enabled = useInteractivity()
  const theme = useTheme()
  const toast = useToast()
  const [state, setState] = createStore({
    responding: false,
    focus: "reject" as (typeof REVIEW_FOCUS)[number],
  })
  let input: TextareaRenderable | undefined
  const respond = (value: PermissionReply) => {
    setState("responding", true)
    void props.onReply(value).finally(() => setState("responding", false))
  }
  const approve = (typed: boolean) => {
    if (!enabled() || state.responding) return
    if (typed && ReviewApproval.requestID(input?.plainText ?? "") !== props.request.id) {
      toast.show({ message: "Enter the exact approval phrase for this pending request", variant: "error" })
      return
    }
    respond("review_once")
  }
  const reject = () => {
    if (!enabled() || state.responding) return
    respond("reject")
  }
  const cycle = (step: number) =>
    setState(
      "focus",
      REVIEW_FOCUS[(REVIEW_FOCUS.indexOf(state.focus) + step + REVIEW_FOCUS.length) % REVIEW_FOCUS.length],
    )
  // A different pending request must never inherit a selected Approve or a typed phrase.
  createEffect(
    on(
      () => props.request.id,
      () => {
        setState("focus", "reject")
        input?.setText("")
      },
      { defer: true },
    ),
  )
  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      { bind: "tab", title: "Next review control", group: "Permission", run: () => cycle(1) },
      { bind: "shift+tab", title: "Previous review control", group: "Permission", run: () => cycle(-1) },
      {
        bind: "return",
        title: state.focus === "input" ? "Approve this review ID once" : "Confirm selected review action",
        group: "Permission",
        run: () => {
          if (state.focus === "input") return approve(true)
          if (state.focus === "approve") return approve(false)
          reject()
        },
      },
      { bind: "escape", title: "Reject permission", group: "Permission", run: reject },
      // Arrow keys belong to the phrase field's caret while it has focus.
      ...(state.focus === "input"
        ? []
        : [
            {
              bind: "left,right,up,down,h,l",
              title: "Switch review action",
              group: "Permission",
              run: () => setState("focus", state.focus === "approve" ? "reject" : "approve"),
            },
          ]),
    ],
  }))
  const action = (option: "reject" | "approve", label: string, semantic: string, run: () => void) => (
    <box
      ref={SimulationSemantics.bind(() => ({
        instance: props.request.id,
        role: "button",
        label: semantic,
        focused: state.focus === option,
        selected: state.focus === option,
        disabled: !enabled() || state.responding,
      }))}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      backgroundColor={
        state.focus === option ? theme.background.action.primary.focused : theme.background.action.primary.base
      }
      onMouseUp={run}
    >
      <text fg={state.focus === option ? theme.text.action.primary.focused : theme.text.action.primary.base}>
        {label}
      </text>
    </box>
  )
  return (
    <box flexDirection="column" gap={1} padding={1} backgroundColor={theme.background.raised.base}>
      <text fg={theme.text.base}>{`${props.request.id} · session ${props.request.sessionID} · tool ${props.request.action}`}</text>
      <text fg={theme.text.muted}>{props.request.review?.reason}</text>
      <scrollbox height={8}>
        <text fg={theme.text.base}>
          {ReviewApproval.display({ resources: props.request.resources, action: props.request.metadata?.action })}
        </text>
      </scrollbox>
      <box flexDirection="row" gap={1} onMouseDown={() => setState("focus", "input")}>
        <text fg={state.focus === "input" ? theme.text.base : theme.text.muted} flexShrink={0}>
          {state.focus === "input" ? "›" : " "}
        </text>
        <textarea
          ref={(value: TextareaRenderable) => {
            input = value
            SimulationSemantics.bind(() => ({
              instance: props.request.id,
              role: "textbox",
              label: "Approval phrase",
              focused: value.focused,
              disabled: !enabled() || state.responding,
            }))(value)
          }}
          height={1}
          flexGrow={1}
          focused={enabled() && !state.responding && state.focus === "input"}
          placeholder={`I approve ${props.request.id}`}
        />
      </box>
      <box flexDirection="row" gap={1} flexWrap="wrap">
        {action("reject", "Don't approve", `Don't approve ${props.request.id}`, reject)}
        {action("approve", "Approve once", `Approve ${props.request.id} once`, () => approve(false))}
      </box>
      <text fg={theme.text.muted}>
        {state.focus === "input"
          ? "type the phrase · enter approve · tab next · esc reject"
          : "⇆ select · enter confirm · tab next · esc reject"}
      </text>
      <text fg={theme.text.muted}>Scroll the action above to inspect it in full</text>
    </box>
  )
}

function RejectPrompt(props: {
  action: string
  instance: string
  onConfirm: (message: string) => void
  onCancel: () => void
}) {
  let input: TextareaRenderable
  const enabled = useInteractivity()
  const theme = useTheme()
  const cursorStyle = useCursorStyle()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      {
        id: "app.exit",
        title: "Cancel permission rejection",
        group: "Permission",
        run(_input, event) {
          if (event?.ctrl && event.name === "c" && input.plainText) {
            input.setText("")
            return
          }
          props.onCancel()
        },
      },
      { bind: "escape", title: "Cancel permission rejection", group: "Permission", run: () => props.onCancel() },
      {
        bind: "return",
        title: "Confirm permission rejection",
        group: "Permission",
        run: () => props.onConfirm(input.plainText),
      },
    ],
  }))

  return (
    <box
      id="session.permission.reject"
      ref={SimulationSemantics.bind(() => ({
        instance: props.instance,
        role: "dialog",
        label: `Reject permission: ${props.action}`,
      }))}
      backgroundColor={theme.background.raised.base}
      border={["left"]}
      borderColor={theme.text.feedback.error.base}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.text.feedback.error.base}>{"△"}</text>
          <text fg={theme.text.base}>Reject permission</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.text.muted}>Tell OpenCode what to do differently</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.decrease(theme.background.raised.base)}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          id="session.permission.reject.message"
          ref={(val: TextareaRenderable) => {
            input = val
            SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "textbox",
              label: "Rejection reason",
              focused: val.focused,
              disabled: false,
            }))(val)
            val.traits = { status: "REJECT" }
          }}
          focused={enabled()}
          textColor={theme.text.base}
          focusedTextColor={theme.text.base}
          cursorColor={theme.text.base}
          cursorStyle={cursorStyle()}
        />
        <box
          id="session.permission.reject.actions"
          ref={SimulationSemantics.bind(() => ({
            instance: props.instance,
            role: "group",
            label: "Rejection actions",
          }))}
          flexDirection="row"
          gap={2}
          flexShrink={0}
        >
          <box
            id="session.permission.reject.confirm"
            ref={SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "button",
              label: "Confirm rejection",
              disabled: false,
            }))}
            onMouseUp={() => props.onConfirm(input.plainText)}
          >
            <text fg={theme.text.base}>
              enter <span style={{ fg: theme.text.muted }}>confirm</span>
            </text>
          </box>
          <box
            id="session.permission.reject.cancel"
            ref={SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "button",
              label: "Cancel rejection",
              disabled: false,
            }))}
            onMouseUp={props.onCancel}
          >
            <text fg={theme.text.base}>
              esc <span style={{ fg: theme.text.muted }}>cancel</span>
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

export function SessionQuestion<const T extends Record<string, string>>(props: {
  title: string
  semanticLabel?: string
  instance: string
  id?: string
  group?: string
  choicesLabel?: string
  header?: JSX.Element
  body: JSX.Element | ((option: keyof T, view: { expanded: boolean }) => JSX.Element)
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const narrow = createMemo(() => dimensions().width < 80)
  const shortcuts = Keymap.useShortcuts()
  const id = () => props.id ?? "session.permission"
  const group = () => props.group ?? "Permission"
  const dismiss = () => {
    if (store.expanded) {
      setStore("expanded", false)
      return
    }
    if (props.escapeKey) props.onSelect(props.escapeKey)
  }

  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      ...(props.escapeKey
        ? [
            {
              id: "app.exit",
              title: "Reject permission",
              group: group(),
              bind: false as const,
              run: dismiss,
            },
          ]
        : []),
      ...(props.fullscreen
        ? [
            {
              id: "permission.prompt.fullscreen",
              title: "Toggle permission fullscreen",
              group: group(),
              bind: false as const,
              run: () => setStore("expanded", (value) => !value),
            },
          ]
        : []),
      ...(keys.length > 1
        ? [
            {
              bind: "left,h",
              title: "Previous option",
              group: group(),
              run: () => {
                const index = keys.indexOf(store.selected)
                setStore("selected", keys[(index - 1 + keys.length) % keys.length])
              },
            },
            {
              bind: "right,l",
              title: "Next option",
              group: group(),
              run: () => {
                const index = keys.indexOf(store.selected)
                setStore("selected", keys[(index + 1) % keys.length])
              },
            },
          ]
        : []),
      {
        bind: "return",
        title: "Select option",
        group: group(),
        run: () => props.onSelect(store.selected),
      },
      ...(props.escapeKey ? [{ bind: "escape", title: "Reject permission", group: group(), run: dismiss }] : []),
    ],
    bindings: [...(props.escapeKey ? ["app.exit"] : []), ...(props.fullscreen ? ["permission.prompt.fullscreen"] : [])],
  }))

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))
  useRenderer()

  const content = () => (
    <box
      id={id()}
      ref={SimulationSemantics.bind(() => ({
        instance: props.instance,
        role: "dialog",
        label: props.semanticLabel ?? props.title,
        expanded: store.expanded,
      }))}
      backgroundColor={theme.background.raised.base}
      border={["left"]}
      borderColor={theme.background.action.primary.focused}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <Show
          when={props.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={theme.text.feedback.warning.base}>{"△"}</text>
              <text fg={theme.text.base}>{props.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {props.header}
          </box>
        </Show>
        {typeof props.body === "function" ? props.body(store.selected, { expanded: store.expanded }) : props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.decrease(theme.background.raised.base)}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box
          id={`${id()}.actions`}
          ref={SimulationSemantics.bind(() => ({
            instance: props.instance,
            role: "listbox",
            label: props.choicesLabel ?? "Permission choices",
          }))}
          flexDirection="row"
          gap={1}
          flexShrink={0}
        >
          <For each={keys}>
            {(option) => (
              <box
                id={`${id()}.action.${String(option)}`}
                ref={SimulationSemantics.bind(() => ({
                  instance: props.instance,
                  role: "option",
                  label: props.options[option],
                  focused: option === store.selected,
                  selected: option === store.selected,
                  disabled: false,
                }))}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  option === store.selected
                    ? theme.background.action.primary.focused
                    : theme.background.action.primary.base
                }
                onMouseMove={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text
                  fg={option === store.selected ? theme.text.action.primary.focused : theme.text.action.primary.base}
                >
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.text.base}>
              {shortcuts.get("permission.prompt.fullscreen")} <span style={{ fg: theme.text.muted }}>{hint()}</span>
            </text>
          </Show>
          <Show when={keys.length > 1}>
            <text fg={theme.text.base}>
              {"⇆"} <span style={{ fg: theme.text.muted }}>select</span>
            </text>
          </Show>
          <text fg={theme.text.base}>
            enter <span style={{ fg: theme.text.muted }}>confirm</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
