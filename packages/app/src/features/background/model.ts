// The session's tracked jobs and saved descendants.

type Node = { id: string; parentID?: string | null }

/** Saved descendants of this session only, whichever way they were started. */
export function descendants<T extends Node>(sessions: readonly T[], sessionID: string) {
  const children = new Map<string, T[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  }
  const found: Array<{ session: T; depth: number }> = []
  const visited = new Set<string>([sessionID])
  const walk = (id: string, depth: number) => {
    for (const child of children.get(id) ?? []) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      found.push({ session: child, depth })
      walk(child.id, depth + 1)
    }
  }
  walk(sessionID, 0)
  return found
}

/** A short model label, e.g. "gpt-6.1-sol (high)". */
export function shortModelLabel(model: { id?: string; variant?: string } | undefined) {
  if (!model?.id) return undefined
  const id = model.id.replace(/-oauth$/, "")
  return model.variant ? `${id} (${model.variant})` : id
}
