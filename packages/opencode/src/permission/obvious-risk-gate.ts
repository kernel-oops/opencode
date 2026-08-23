import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import {
  validateExceptionalRiskAssessment,
  validateObviousRiskAssessment,
  type RiskPolicyAssessment,
} from "./reviewer-assessment"

export function isObviousRiskCandidate(input: {
  readonly settled: boolean
  readonly permission: string
  readonly assessment: RiskPolicyAssessment
  readonly snapshot: PermissionReviewSnapshot
  readonly policy?: "obvious-risk-only-v1" | "exceptional-risk-only-v1"
}) {
  const action = input.snapshot.action
  const validated =
    input.policy === "exceptional-risk-only-v1"
      ? validateExceptionalRiskAssessment(input.assessment)
      : validateObviousRiskAssessment(input.assessment)
  const cwdComplete =
    action.cwd_status === "not_applicable" ||
    (action.cwd_status === "exact" && typeof action.cwd === "string" && action.cwd.length > 0)
  return (
    input.settled &&
    !("failure" in validated) &&
    input.permission === "bash" &&
    action.permission === "bash" &&
    action.identity === "bash" &&
    action.origin === "tool" &&
    action.complete &&
    action.omitted_items === 0 &&
    action.omitted_bytes === 0 &&
    cwdComplete
  )
}

const rewriteFeedback = {
  inspect_read_only: "Use a read-only inspection instead of performing this action.",
  use_dry_run: "Use a genuine dry-run that cannot apply changes.",
  narrow_target: "Narrow the action to the smallest necessary target.",
  remove_privilege_change: "Retry without changing privileges, identity, or security boundaries.",
  avoid_sensitive_data: "Retry without exposing credentials or sensitive data.",
  use_trusted_local_input: "Use trusted local input instead of remote or untrusted content.",
  avoid_persistence_or_public_effect: "Retry without persistence or a public side effect.",
} as const

export function obviousRiskRewriteFeedback(alternative: RiskPolicyAssessment["safer_alternative"]) {
  if (alternative === "none" || alternative === "request_specific_authorisation") return
  return rewriteFeedback[alternative]
}
