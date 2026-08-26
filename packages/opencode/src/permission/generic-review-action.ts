import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import {
  validateExceptionalRiskAssessment,
  validateObviousRiskAssessment,
  type RiskPolicyAssessment,
} from "./reviewer-assessment"

interface Contract {
  readonly permissions: readonly string[]
  readonly cwd: "session" | "not_applicable"
  readonly arguments: "path_omitted" | "mcp_resource" | "query"
}

const contracts: Readonly<Record<string, Contract>> = {
  glob: { permissions: ["glob"], cwd: "session", arguments: "path_omitted" },
  grep: { permissions: ["grep"], cwd: "session", arguments: "path_omitted" },
  websearch: { permissions: ["websearch"], cwd: "not_applicable", arguments: "query" },
  read_mcp_resource: { permissions: ["read"], cwd: "not_applicable", arguments: "mcp_resource" },
}

function argumentsComplete(contract: Contract, value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (contract.arguments === "path_omitted")
    return typeof input.pattern === "string" && input.pattern.length > 0 && !Object.hasOwn(input, "path")
  if (contract.arguments === "query") return typeof input.query === "string" && input.query.length > 0
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes("server") || !keys.includes("uri")) return false
  return (
    typeof input.server === "string" && input.server.length > 0 && typeof input.uri === "string" && input.uri.length > 0
  )
}

export function resolveReviewAction(input: {
  readonly builtin: boolean
  readonly identity: string
  readonly arguments: unknown
  readonly directory: string
  readonly requested?: PermissionV1.ReviewAction
}): PermissionV1.ReviewAction {
  if (!input.builtin) return { identity: input.identity, arguments: input.arguments, complete: false }
  const contract = contracts[input.identity]
  if (input.requested) {
    if (input.requested.identity !== input.identity)
      return { identity: input.identity, arguments: input.arguments, complete: false }
    if (
      contract &&
      (!argumentsComplete(contract, input.arguments) || !argumentsComplete(contract, input.requested.arguments))
    )
      return { ...input.requested, complete: false }
    return input.requested
  }
  if (!contract || !argumentsComplete(contract, input.arguments))
    return { identity: input.identity, arguments: input.arguments, complete: false }
  return {
    identity: input.identity,
    arguments: input.arguments,
    cwd: contract.cwd === "session" ? input.directory : null,
    complete: true,
  }
}

export function isGenericRiskAllowCandidate(input: {
  readonly settled: boolean
  readonly permission: string
  readonly assessment: RiskPolicyAssessment
  readonly snapshot: PermissionReviewSnapshot
  readonly policy?: "obvious-risk-only-v1" | "exceptional-risk-only-v1"
}) {
  const action = input.snapshot.action
  const contract = contracts[action.identity]
  if (!contract) return false
  const validated =
    input.policy === "exceptional-risk-only-v1"
      ? validateExceptionalRiskAssessment(input.assessment)
      : validateObviousRiskAssessment(input.assessment)
  const cwdComplete =
    contract.cwd === "not_applicable"
      ? action.cwd_status === "not_applicable"
      : action.cwd_status === "exact" && typeof action.cwd === "string" && action.cwd.length > 0
  const trusted = input.snapshot.trusted
  return (
    input.settled &&
    !("failure" in validated) &&
    input.assessment.outcome === "allow" &&
    contract.permissions.includes(input.permission) &&
    action.permission === input.permission &&
    action.origin === "tool" &&
    action.complete &&
    action.omitted_items === 0 &&
    action.omitted_bytes === 0 &&
    argumentsComplete(contract, action.arguments) &&
    cwdComplete &&
    input.snapshot.context_safe_for_gate &&
    trusted.complete &&
    trusted.omitted_items === 0 &&
    trusted.omitted_bytes === 0 &&
    trusted.items.length > 0 &&
    trusted.items.every((item) => item.source === "human" && item.trusted)
  )
}
