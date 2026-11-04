import { createMemo, type Accessor } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { sessionPermissionRequest, sessionFormRequest } from "@/session/requests/session-request-tree"
import { ServerConnection } from "@/runtime/server/registry"
import { AppExtensions } from "@/extensions/registry"
import { projectSettingsKey, useSettings } from "@/settings/model"

type ServerData = ReturnType<ReturnType<typeof useGlobal>["ensureServerCtx"]>["data"]

// Without a server (no session in view) the session reads as idle and read.
export function useSessionTabAvatarState(
  server: Accessor<ServerConnection.Key | undefined>,
  sessionId: Accessor<string>,
  root?: Accessor<boolean>,
  snapshot?: Accessor<SessionInfo | undefined>,
) {
  const global = useGlobal()
  const settings = useSettings()
  const connection = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === server()))
  const serverCtx = useServerCtx(connection)

  const requests = createMemo(() => {
    const ctx = serverCtx()

    if (!ctx) return { permission: false, form: false }

    const project = projectSettingsKey(ctx.sdk.scope, ctx.data.session.get(sessionId())?.projectID)

    return sessionRequests(ctx.data, sessionId(), root?.() ?? false, settings.permissions.autoApproves(project))
  })

  const needsAttention = createMemo(() => requests().permission || requests().form)

  const unread = createMemo(
    () => needsAttention() || (serverCtx()?.notification.session.unread(sessionId(), snapshot?.()) ?? false),
  )

  const loading = createMemo(() => {
    const data = serverCtx()?.data

    if (!data) return false

    if (needsAttention()) return false
    // Keep both pending inbox work and custom background-provider work visible as busy.
    const busy = (id: string) =>
      sessionBusy(data, id) ||
      AppExtensions.isBusy(id, data)

    if (root?.())
      return data.session
        .list()
        .some((session) => data.session.root(session.id) === sessionId() && busy(session.id))

    return busy(sessionId())
  })

  return { unread, loading, attention: needsAttention }
}

// Pending permission and form requests anywhere in the session (or its family, for roots).
export function sessionRequests(data: ServerData, sessionId: string, root: boolean, autoApprove: boolean) {
  const sessions = root
    ? [...new Set([sessionId, ...data.session.family(sessionId)])].flatMap((id) => {
        const info = data.session.get(id)

        return info ? [info] : []
      })
    : data.session.list()

  return {
    permission: !!sessionPermissionRequest(sessions, data.session.permission.list, sessionId, (request) => !autoApprove || !!request.review),
    form: !!sessionFormRequest(sessions, data.session.form.list, sessionId),
  }
}

// Like the TUI, work waiting in the inbox counts as busy; parked synthetic context does not.
export function sessionBusy(data: ServerData, sessionId: string) {
  return (
    data.session.status(sessionId) === "running" ||
    data.session.pending.list(sessionId).some((item) => item.type !== "synthetic")
  )
}
