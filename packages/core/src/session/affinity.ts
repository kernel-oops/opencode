export * as SessionAffinity from "./affinity.js"

import { Effect } from "effect"
import type { SessionSchema } from "./schema.js"

// TODO: Should the `model.request` hook expose affinity so plugins stop deriving it from `ctx.session.get`?
/** Resolve cache routing through parents and fork sources, without changing the requesting Session's identity. */
export const get = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  load: (sessionID: SessionSchema.ID) => Effect.Effect<Pick<SessionSchema.Info, "parentID" | "fork"> | undefined>,
) {
  const visited = new Set<SessionSchema.ID>()
  let current = sessionID
  for (let loads = 0; loads < 256; loads++) {
    if (visited.has(current)) return sessionID
    visited.add(current)
    const session = yield* load(current)
    const source = session?.parentID ?? session?.fork?.sessionID
    // Preserve the last referenced ID when an ancestor is unavailable.
    if (source === undefined) return current
    current = source
  }
  // Corrupt cycles and excessive ancestry must not block a model request.
  return sessionID
})
