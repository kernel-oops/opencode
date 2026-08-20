import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import type { Assessment } from "./reviewer-assessment"

export function isAdvisoryAllowCandidate(input: {
  readonly settled: boolean
  readonly assessment: Assessment
  readonly snapshot: PermissionReviewSnapshot
}) {
  const action = input.snapshot.action
  return (
    input.settled &&
    input.assessment.outcome === "allow" &&
    input.assessment.risk_level === "low" &&
    input.assessment.user_authorization === "explicit" &&
    action.complete &&
    action.omitted_items === 0 &&
    action.omitted_bytes === 0 &&
    (action.cwd_status === "exact" || action.cwd_status === "not_applicable") &&
    input.snapshot.trusted.complete &&
    input.snapshot.trusted.omitted_items === 0 &&
    input.snapshot.trusted.omitted_bytes === 0 &&
    input.snapshot.trusted.items.length > 0 &&
    input.snapshot.trusted.items.every((item) => item.source === "human" && item.trusted) &&
    input.snapshot.context_safe_for_gate
  )
}
