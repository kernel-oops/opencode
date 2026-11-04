import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { createStore } from "solid-js/store"
import { ReviewApproval } from "@opencode/util/bound/review-approval"

type Decision = "once" | "always" | "reject" | "review_once"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  // Resolves true only when the server accepted the reply.
  onDecide: (response: Decision, message?: string) => Promise<boolean>
}) {
  const language = useLanguage()
  const data = useData()
  const [state, setState] = createStore({ text: "", error: false, rejecting: false, feedback: "" })
  const save = () => (props.request.review ? [] : (props.request.save ?? []))
  // Like the TUI, an ordinary request from a subagent can be denied with feedback; everything else denies at once.
  const feedback = () => !props.request.review && !!data.session.get(props.request.sessionID)?.parentID

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])

    if (value === key) return ""

    return value
  }

  const deny = () => {
    if (feedback()) return setState("rejecting", true)
    void props.onDecide("reject")
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Show
              when={state.rejecting}
              fallback={
                <>
                  <Button variant="ghost" size="normal" onClick={deny} disabled={props.responding}>
                    {language.t("ui.permission.deny")}
                  </Button>
                  <Show when={save().length > 0}>
                    <Button
                      variant="neutral"
                      size="normal"
                      onClick={() => void props.onDecide("always")}
                      disabled={props.responding}
                    >
                      {language.t("ui.permission.allowAlways")}
                    </Button>
                  </Show>
                  <Button
                    variant="submit"
                    size="normal"
                    onClick={() => void props.onDecide(props.request.review ? "review_once" : "once")}
                    disabled={props.responding}
                  >
                    {props.request.review
                      ? language.t("permission.review.approve", { id: props.request.id })
                      : language.t("ui.permission.allowOnce")}
                  </Button>
                </>
              }
            >
              <Button
                variant="ghost"
                size="normal"
                onClick={() => setState({ rejecting: false, feedback: "" })}
                disabled={props.responding}
              >
                {language.t("common.cancel")}
              </Button>
              <Button
                variant="submit"
                size="normal"
                onClick={() => void props.onDecide("reject", state.feedback.trim() || undefined)}
                disabled={props.responding}
              >
                {language.t("permission.reject.confirm")}
              </Button>
            </Show>
          </div>
        </>
      }
    >
      <div class="flex flex-col gap-2 min-w-0 min-h-0">
        {/* Masked display only; the server binds the original values. One capped scroller holds every
            long part, so the reply inputs and decision controls below it stay in view. */}
        <div
          tabIndex={0}
          data-scrollable
          role="region"
          aria-label={language.t("permission.scope.label")}
          class="min-h-0 max-h-[35dvh] overflow-auto space-y-2"
        >
          <div class="text-12-regular text-text-weak break-all">
            {language.t("permission.review.scope", {
              id: props.request.id,
              session: props.request.sessionID,
              tool: props.request.action,
            })}
          </div>
          <Show when={props.request.review?.reason ?? props.request.message}>
            {(reason) => <div class="whitespace-pre-wrap break-words">{reason()}</div>}
          </Show>
          <Show when={toolDescription()}>
            <div data-slot="permission-hint">{toolDescription()}</div>
          </Show>
          <pre class="text-12-regular text-text-base whitespace-pre-wrap break-all m-0">
            {ReviewApproval.display({ resources: props.request.resources, action: props.request.metadata?.action })}
          </pre>
          <Show when={save().length > 0}>
            <div class="flex flex-col gap-1">
              <div class="text-12-regular text-text-weak">{language.t("permission.always.scope")}</div>
              <div data-slot="permission-patterns">
                <For each={save()}>
                  {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
                </For>
              </div>
            </div>
          </Show>
        </div>
        <Show when={props.request.review}>
          <form
            onSubmit={(event) => {
              event.preventDefault()

              if (props.responding) return

              if (ReviewApproval.requestID(state.text) !== props.request.id) return setState("error", true)

              setState("error", false)
              // Keep the typed phrase until the server accepts the approval.
              void props.onDecide("review_once").then((accepted) => {
                if (accepted) setState("text", "")
              })
            }}
          >
            <input
              value={state.text}
              onInput={(event) => setState("text", event.currentTarget.value)}
              aria-label={language.t("permission.review.placeholder", { id: props.request.id })}
              placeholder={language.t("permission.review.placeholder", { id: props.request.id })}
              disabled={props.responding}
            />
            <Show when={state.error}>
              <div role="alert">{language.t("permission.review.invalid")}</div>
            </Show>
          </form>
        </Show>
        <Show when={state.rejecting}>
          <textarea
            value={state.feedback}
            onInput={(event) => setState("feedback", event.currentTarget.value)}
            aria-label={language.t("permission.reject.feedback")}
            placeholder={language.t("permission.reject.feedback")}
            disabled={props.responding}
            rows={3}
            class="shrink-0"
          />
        </Show>
      </div>
    </DockPrompt>
  )
}
