import { describe, expect, test } from "bun:test"
import {
  OBVIOUS_RISK_INSTRUCTIONS,
  parseObviousRiskAssessment,
  validateObviousRiskAssessment,
} from "../../src/permission/reviewer-assessment"

const valid = [
  ["allow", "routine_or_low_impact", "none"],
  ["allow", "specifically_authorised_operation", "none"],
  ["rewrite", "scope_can_be_narrowed", "inspect_read_only"],
  ["rewrite", "scope_can_be_narrowed", "use_dry_run"],
  ["rewrite", "scope_can_be_narrowed", "narrow_target"],
  ["rewrite", "scope_can_be_narrowed", "remove_privilege_change"],
  ["rewrite", "scope_can_be_narrowed", "avoid_sensitive_data"],
  ["rewrite", "scope_can_be_narrowed", "use_trusted_local_input"],
  ["rewrite", "scope_can_be_narrowed", "avoid_persistence_or_public_effect"],
  ["rewrite", "destructive_or_irreversible", "inspect_read_only"],
  ["rewrite", "destructive_or_irreversible", "use_dry_run"],
  ["rewrite", "destructive_or_irreversible", "narrow_target"],
  ["rewrite", "privilege_identity_or_security_boundary", "inspect_read_only"],
  ["rewrite", "privilege_identity_or_security_boundary", "remove_privilege_change"],
  ["rewrite", "credential_or_sensitive_data", "inspect_read_only"],
  ["rewrite", "credential_or_sensitive_data", "avoid_sensitive_data"],
  ["rewrite", "untrusted_code_or_remote_payload", "inspect_read_only"],
  ["rewrite", "untrusted_code_or_remote_payload", "use_trusted_local_input"],
  ["rewrite", "persistence_or_public_side_effect", "inspect_read_only"],
  ["rewrite", "persistence_or_public_side_effect", "use_dry_run"],
  ["rewrite", "persistence_or_public_side_effect", "avoid_persistence_or_public_effect"],
  ["human_review", "destructive_or_irreversible", "request_specific_authorisation"],
  ["human_review", "privilege_identity_or_security_boundary", "request_specific_authorisation"],
  ["human_review", "credential_or_sensitive_data", "request_specific_authorisation"],
  ["human_review", "untrusted_code_or_remote_payload", "request_specific_authorisation"],
  ["human_review", "persistence_or_public_side_effect", "request_specific_authorisation"],
  ["human_review", "intent_unclear_or_conflicting", "inspect_read_only"],
  ["human_review", "intent_unclear_or_conflicting", "request_specific_authorisation"],
] as const

describe("obvious-risk-only-v1 assessment", () => {
  test("accepts every fixed semantic combination", () => {
    for (const [outcome, reason_code, safer_alternative] of valid) {
      expect(validateObviousRiskAssessment({ outcome, reason_code, safer_alternative })).toEqual({
        assessment: { outcome, reason_code, safer_alternative },
      })
    }
  })

  test("rejects unknown, extra, missing, and invalid semantic combinations", () => {
    for (const value of [
      null,
      [],
      {},
      { outcome: "allow", reason_code: "routine_or_low_impact" },
      { outcome: "approve", reason_code: "routine_or_low_impact", safer_alternative: "none" },
      { outcome: "allow", reason_code: "unknown", safer_alternative: "none" },
      { outcome: "allow", reason_code: "routine_or_low_impact", safer_alternative: "inspect_read_only" },
      { outcome: "rewrite", reason_code: "credential_or_sensitive_data", safer_alternative: "use_dry_run" },
      {
        outcome: "human_review",
        reason_code: "scope_can_be_narrowed",
        safer_alternative: "request_specific_authorisation",
      },
      {
        outcome: "allow",
        reason_code: "routine_or_low_impact",
        safer_alternative: "none",
        rationale: "model prose is forbidden",
      },
    ]) {
      expect(validateObviousRiskAssessment(value)).toEqual({ failure: "malformed" })
    }
  })

  test("parses only one bounded JSON object", () => {
    expect(
      parseObviousRiskAssessment(
        JSON.stringify({
          outcome: "rewrite",
          reason_code: "scope_can_be_narrowed",
          safer_alternative: "narrow_target",
        }),
      ),
    ).toHaveProperty("assessment.outcome", "rewrite")
    expect(parseObviousRiskAssessment("```json\n{}\n```")).toEqual({ failure: "malformed" })
    expect(parseObviousRiskAssessment("x".repeat(2_049))).toEqual({ failure: "size" })
  })

  test("uses the final fixed policy prompt without accepting arbitrary prose", () => {
    expect(OBVIOUS_RISK_INSTRUCTIONS).toStartWith(
      "You are an isolated permission reviewer applying Marc's fixed obvious-risk-only-v1 profile.",
    )
    expect(OBVIOUS_RISK_INSTRUCTIONS).toContain("Missing bounded untrusted context alone is not a reason to refuse.")
    expect(OBVIOUS_RISK_INSTRUCTIONS).toEndWith(
      "safer_alternative must be none, inspect_read_only, use_dry_run, narrow_target, remove_privilege_change, avoid_sensitive_data, use_trusted_local_input, avoid_persistence_or_public_effect, or request_specific_authorisation.",
    )
  })
})
