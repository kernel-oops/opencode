import type { PermissionApi } from "@opencode/client/promise/api"
import type { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import type { Session } from "@opencode/schema/session"
import type { AssertInput } from "../permission.js"
import type { Hooks } from "./registration.js"

export interface PermissionEvaluation {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: Permission.Effect
  message?: string
  /** A classification marker, not authority: only the privately enrolled model reviewer can supply a receipt. */
  review?: { readonly kind: "model-refusal"; readonly reason: string }
  /**
   * Set when the configured rules have already refused the request, explaining why (the deciding rule and its
   * layer). The hook is then called for observation only, e.g. to record refusals: changes to `effect` are ignored.
   */
  readonly refusal?: string
}

export interface PermissionHooks {
  readonly evaluate: PermissionEvaluation
}

export type PermissionDomain = Pick<PermissionApi, "list" | "get" | "reply"> & {
  readonly hook: Hooks<PermissionHooks>
  /**
   * Evaluates the session's permission rules and, when approval is required, prompts the user and
   * waits for the reply. Resolves when allowed. A deny rule or a rejection with feedback rejects with
   * a `Tool.Error` carrying the reason. A plain rejection rejects with an error that ends the current
   * step; rethrow it rather than returning it as tool output.
   * Assertions inside a tool invocation are withdrawn before that invocation settles, including
   * on interruption. Detached callbacks cannot revive a settled invocation; standalone assertions are unchanged.
   */
  readonly assert: (input: typeof AssertInput.Encoded) => Promise<void>
}
