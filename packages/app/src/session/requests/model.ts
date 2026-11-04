import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { FormInfo, PermissionRequest } from "@opencode/client/promise"
import { useParams } from "@solidjs/router"
import { showToast } from "@/shell/notifications/toast"
import { useServerSDK } from "@/runtime/server/client"
import { useLanguage } from "@/runtime/i18n/language"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useWorkspaceLocation } from "@/workspaces/location"
import { sessionPermissionRequest, sessionFormRequest, sessionTreeIDs } from "@/session/requests/session-request-tree"
import { createWebSearchRequest } from "./websearch"
import { createSessionBackground } from "@/session/requests/background"
import { createSteerBackground } from "@/session/requests/steer-background"
import { useData } from "@/runtime/server/current"

export function createSessionRequestModel() {
  const params = useParams()
  const sdk = useWorkspaceLocation()
  const serverSDK = useServerSDK()
  const data = useData()
  const language = useLanguage()
  const settings = useSettings()
  createEffect(() => {
    const id = params.id

    if (!id || serverSDK.connection.status() !== "connected") return
    void data.shell.sync({ directory: sdk().directory }).catch(() => undefined)
  })
  // The route loads only the first page of direct children. Hydrate the whole selected tree, so a request waiting in
  // a deeper or later-paged descendant is found; leaving this Session stops further traversal.
  createEffect(() => {
    const id = params.id

    if (!id || serverSDK.connection.status() !== "connected") return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void data.session.descendants.sync(id, { signal: controller.signal }).catch(() => undefined)
  })
  // A descendant may already be waiting when this view connects, so sync the whole tree, not only this Session.
  createEffect(() => {
    const id = params.id

    if (!id || serverSDK.connection.status() !== "connected") return
    void Promise.allSettled(
      sessionTreeIDs(data.session.list(), id).flatMap((sessionID) => [
        data.session.permission.sync(sessionID),
        data.session.form.sync(sessionID),
      ]),
    )
  })

  const formRequest = createMemo((): FormInfo | undefined => {
    return sessionFormRequest(data.session.list(), data.session.form.list, params.id)
  })

  // MCP elicitations are owned by the Location rather than a Session, so they are listed per Location.
  const location = createMemo(() => {
    const id = params.id

    return id ? data.session.get(id)?.location : undefined
  })

  createEffect(() => {
    const ref = location()

    if (!ref || serverSDK.connection.status() !== "connected") return
    void data.session.form.sync("global", ref).catch(() => undefined)
  })

  const websearch = createWebSearchRequest({
    owner: () => params.id,
    connected: () => serverSDK.connection.status() === "connected",
    request: () => {
      const form = formRequest()

      return form?.metadata?.kind === "websearch.provider" ? form : undefined
    },
    providers: async (sessionID) => {
      const session = data.session.get(sessionID) ?? (await serverSDK.api.session.get({ sessionID }))

      const result = await serverSDK.api.websearch.providers({
        location: { directory: session.location.directory },
      })

      return result.data.map((provider) => ({ value: provider.id, label: provider.name }))
    },
    reply: (input) => data.session.form.reply(input),
    events: serverSDK.event,
  })

  const questionRequest = createMemo(() => {
    if (websearch.request()) return
    const form = formRequest()

    return form?.metadata?.kind === "question" ? form : undefined
  })

  const elicitationRequest = createMemo(() => {
    if (websearch.request() || questionRequest()) return
    const form = formRequest()

    if (form?.metadata?.kind === "mcp-elicitation") return form

    const ref = location()

    if (!ref) return

    return data.session.form.list("global", ref)?.find((item) => item.metadata?.kind === "mcp-elicitation")
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    const id = params.id

    const project = projectSettingsKey(serverSDK.scope, id ? data.session.get(id)?.projectID : undefined)

    return sessionPermissionRequest(data.session.list(), data.session.permission.list, id,
      (request) => !settings.permissions.autoApproves(project) || !!request.review)
  })

  const blocked = createMemo(() => {
    const id = params.id

    if (!id) return false

    return !!permissionRequest() || !!questionRequest() || !!elicitationRequest() || !!websearch.request()
  })

  const primary = () => {
    const id = params.id

    return !!id && !data.session.get(id)?.parentID
  }

  const running = createSessionBackground({
    sessionID: () => params.id,
    messages: data.session.message.list,
    sessions: data.session.list,
    status: data.session.status,
    shells: () => data.shell.list({ directory: sdk().directory }),
  })

  // Moving to the background and the plugins' background list stay with the primary session's own work.
  const blocking = createMemo(() => (primary() ? running.blocking() : []))
  const subagents = createMemo(() => (primary() ? running.subagents() : []))
  const tasks = createMemo(() => (primary() ? running.tasks() : []))

  const moveToBackground = async () => {
    if (!primary()) return
    const sessionID = params.id

    if (!sessionID) return
    await serverSDK.api.session.background({ sessionID }).catch((error) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const steer = createSteerBackground({
    sessionID: () => params.id,
    blocking,
    move: (sessionID) => serverSDK.api.session.background({ sessionID }),
  })

  const [store, setStore] = createStore<{ responding: string | undefined }>({ responding: undefined })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()

    if (!perm) return false

    return store.responding === perm.id
  })

  // Resolves true only once the server accepted the reply, so callers keep typed input on any failure.
  const decide = async (
    request: PermissionRequest,
    response: "once" | "always" | "reject" | "review_once",
    message?: string,
  ) => {
    if (permissionRequest()?.id !== request.id || store.responding === request.id) return false

    setStore("responding", request.id)

    return data.session.permission
      .reply({ sessionID: request.sessionID, requestID: request.id, decision: response, message })
      .then(
        () => true,
        (error) => {
          showToast({
            title: language.t("common.requestFailed"),
            description: error instanceof Error ? error.message : String(error),
          })

          return false
        },
      )
      .finally(() => {
        setStore("responding", (id) => (id === request.id ? undefined : id))
      })
  }

  return {
    blocked,
    questionRequest,
    elicitationRequest,
    websearch,
    permissionRequest,
    permissionResponding,
    background: {
      blocking,
      subagents,
      tasks,
      move: moveToBackground,
      steer,
    },
    decide,
  }
}

export type SessionRequestModel = ReturnType<typeof createSessionRequestModel>
