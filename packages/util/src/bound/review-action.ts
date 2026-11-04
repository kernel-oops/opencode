export * as ReviewAction from "./review-action.js"

/**
 * Exact-invocation summary carried in permission request `metadata.action`. A reviewer may allow a
 * `complete` action for this invocation only: the tool has pinned every effect it will have, so the
 * approval cannot be laundered into a broader capability.
 */
export interface Info {
  readonly identity: string
  readonly arguments?: unknown
  readonly cwd?: string | null
  readonly complete: boolean
}

export const make = (input: Info): Info => input

/** Metadata key under which tools publish their review action. */
export const KEY = "action"
