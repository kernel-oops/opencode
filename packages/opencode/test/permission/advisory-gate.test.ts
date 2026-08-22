import { describe, expect, test } from "bun:test"
import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import { isAdvisoryAllowCandidate } from "../../src/permission/advisory-gate"
import { isObviousRiskCandidate, obviousRiskRewriteFeedback } from "../../src/permission/obvious-risk-gate"

const snapshot = {
  version: "1",
  context_safe_for_gate: true,
  action: {
    identity: "bash",
    permission: "bash",
    origin: "tool",
    cwd: "/tmp/project",
    cwd_status: "exact",
    patterns: [],
    metadata: {},
    arguments: { command: "git status" },
    complete: true,
    omitted_items: 0,
    omitted_bytes: 0,
  },
  trusted: {
    items: [{ source: "human", trusted: true, text: "run git status" }],
    complete: true,
    omitted_items: 0,
    omitted_bytes: 0,
  },
  untrusted: { items: [], complete: false, omitted_items: 1, omitted_bytes: 10 },
  complete: false,
} satisfies PermissionReviewSnapshot

describe("permission review advisory gate", () => {
  test("accepts only a settled low-risk explicit lossless allow", () => {
    expect(
      isAdvisoryAllowCandidate({
        settled: true,
        assessment: { outcome: "allow", risk_level: "low", user_authorization: "explicit" },
        snapshot,
      }),
    ).toBe(true)
  })

  test("keeps every weaker or incomplete case on the human route", () => {
    const base = { outcome: "allow" as const, risk_level: "low" as const, user_authorization: "explicit" as const }
    const cases = [
      { settled: false },
      { assessment: { ...base, outcome: "ask" as const } },
      { assessment: { ...base, risk_level: "medium" as const } },
      { assessment: { ...base, user_authorization: "implicit" as const } },
      { snapshot: { ...snapshot, context_safe_for_gate: false } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, complete: false } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, omitted_bytes: 1 } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, cwd_status: "unknown" as const } } },
      { snapshot: { ...snapshot, trusted: { ...snapshot.trusted, complete: false } } },
      { snapshot: { ...snapshot, trusted: { ...snapshot.trusted, omitted_items: 1 } } },
      { snapshot: { ...snapshot, trusted: { ...snapshot.trusted, items: [] } } },
    ]
    for (const change of cases) {
      const settled = "settled" in change && typeof change.settled === "boolean" ? change.settled : true
      const assessment = "assessment" in change && change.assessment ? change.assessment : base
      const candidateSnapshot = "snapshot" in change && change.snapshot ? change.snapshot : snapshot
      expect(
        isAdvisoryAllowCandidate({
          settled,
          assessment,
          snapshot: candidateSnapshot,
        }),
      ).toBe(false)
    }
  })
})

describe("obvious-risk-only-v1 authoritative gate", () => {
  const assessment = {
    outcome: "allow" as const,
    reason_code: "routine_or_low_impact" as const,
    safer_alternative: "none" as const,
  }

  test("accepts settled lossless Bash tool actions despite bounded untrusted context", () => {
    expect(isObviousRiskCandidate({ settled: true, permission: "bash", assessment, snapshot })).toBe(true)
  })

  test("keeps non-Bash, unsettled, lossy, unknown-cwd, and malformed semantic cases human", () => {
    const cases = [
      { settled: false },
      { permission: "edit" },
      { snapshot: { ...snapshot, action: { ...snapshot.action, identity: "write" } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, origin: "doom_loop" as const } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, complete: false } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, omitted_items: 1 } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, omitted_bytes: 1 } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, cwd: undefined, cwd_status: "unknown" as const } } },
      {
        assessment: {
          outcome: "allow" as const,
          reason_code: "destructive_or_irreversible" as const,
          safer_alternative: "none" as const,
        },
      },
    ]
    for (const change of cases) {
      expect(
        isObviousRiskCandidate({
          settled: "settled" in change && change.settled === false ? false : true,
          permission: "permission" in change && change.permission ? change.permission : "bash",
          assessment: "assessment" in change && change.assessment ? change.assessment : assessment,
          snapshot: "snapshot" in change && change.snapshot ? change.snapshot : snapshot,
        }),
      ).toBe(false)
    }
  })

  test("maps alternatives to fixed local feedback only", () => {
    expect(obviousRiskRewriteFeedback("narrow_target")).toBe("Narrow the action to the smallest necessary target.")
    expect(obviousRiskRewriteFeedback("request_specific_authorisation")).toBeUndefined()
    expect(obviousRiskRewriteFeedback("none")).toBeUndefined()
  })
})
