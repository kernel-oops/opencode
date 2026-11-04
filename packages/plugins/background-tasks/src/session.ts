type SessionNode = {
  id: string
  parentID?: string | null
}

export function sessionFamily<T extends SessionNode>(
  sessions: readonly T[],
  sessionID: string,
  include: (session: T) => boolean = () => true,
) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const current = byID.get(sessionID)
  if (!current) return []

  const children = new Map<string, T[]>()
  sessions.forEach((session) => {
    if (!session.parentID) return
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  })

  function root(session: T): T {
    const parent = session.parentID ? byID.get(session.parentID) : undefined
    return parent ? root(parent) : session
  }

  // Keep context ancestors, and calculate connectors from the visible tree rather than the unfiltered inventory.
  const visible = new Set<string>()
  function retain(session: T): boolean {
    const descendants = (children.get(session.id) ?? []).map(retain).some(Boolean)
    if (!include(session) && !descendants) return false
    visible.add(session.id)
    return true
  }
  const ancestor = root(current)
  retain(ancestor)

  function walk(parentID: string, ancestors: boolean[]): Array<{ session: T; prefix: string }> {
    const group = (children.get(parentID) ?? []).filter((session) => visible.has(session.id))
    return group.flatMap((session, index) => {
      const last = index === group.length - 1
      const prefix =
        ancestors.length === 0
          ? ""
          : ancestors
              .slice(1)
              .map((ancestor) => (ancestor ? "   " : "│  "))
              .join("") + (last ? "└─ " : "├─ ")
      return [{ session, prefix }, ...walk(session.id, [...ancestors, last])]
    })
  }

  return walk(ancestor.id, [])
}

type SessionActivity = {
  session: { status(sessionID: string): string | undefined; family(sessionID: string): readonly string[] }
  shell: { listBySession(sessionID: string): readonly unknown[] }
}

/**
 * Whether a session, or any session in its family, is doing work: a running turn, a running subagent, or a
 * background shell command. The session footer already counts background shells; lists must too, or a
 * session running a long command in the background looks idle.
 */
export function sessionActive(data: SessionActivity, sessionID: string) {
  const ids = new Set([sessionID, ...data.session.family(sessionID)])
  for (const id of ids) {
    if (data.session.status(id) === "running" || data.shell.listBySession(id).length > 0) return true
  }
  return false
}

/**
 * The sessions an "open a session" menu offers: top-level ones only, deduplicated, plus the session whose exact ID the
 * user typed even when it is a child. That ID was looked up on purpose, so dropping it for having a parent left
 * pasting a subagent's ID with no way to open it.
 */
export function topLevelSessions<T extends SessionNode>(sessions: readonly T[], exactID?: string): T[] {
  const seen = new Set<string>()
  return sessions.filter((session) => {
    if ((session.parentID && session.id !== exactID) || seen.has(session.id)) return false
    seen.add(session.id)
    return true
  })
}

/**
 * Descendants of a session (children, their children, ...) that are running now.
 * The sidebar's Subagents section lists only jobs the parent tracks; a child woken by a message, or by recovery after a
 * restart, runs untracked and would otherwise not appear there at all.
 */
export function runningDescendants<T extends SessionNode>(
  sessions: readonly T[],
  sessionID: string,
  status: (sessionID: string) => string | undefined,
): T[] {
  const children = new Map<string, T[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  }
  const found: T[] = []
  const visited = new Set<string>([sessionID])
  const walk = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      if (status(child.id) === "running") found.push(child)
      walk(child.id)
    }
  }
  walk(sessionID)
  return found
}

/** A short model label for a subagent row, e.g. "gpt-6.1-sol (high)" or "claude-opus-5-5 (medium)". */
export function shortModelLabel(model: { id?: string; variant?: string } | undefined) {
  if (!model?.id) return undefined
  const id = model.id.replace(/-oauth$/, "")
  return model.variant ? `${id} (${model.variant})` : id
}
