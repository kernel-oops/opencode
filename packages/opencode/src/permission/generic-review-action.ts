import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import path from "node:path"
import { types } from "node:util"
import {
  validateExceptionalRiskAssessment,
  validateObviousRiskAssessment,
  type RiskPolicyAssessment,
} from "./reviewer-assessment"

interface Contract {
  readonly permissions: readonly string[]
  readonly cwd: "session" | "not_applicable"
  readonly arguments: "project_text_file" | "project_literal_grep" | "mcp_resource" | "query"
  readonly requested?: boolean
}

const contracts: Readonly<Record<string, Contract>> = {
  grep: { permissions: ["grep"], cwd: "session", arguments: "project_literal_grep", requested: true },
  read: { permissions: ["read"], cwd: "session", arguments: "project_text_file", requested: true },
  websearch: { permissions: ["websearch"], cwd: "not_applicable", arguments: "query" },
  read_mcp_resource: { permissions: ["read"], cwd: "not_applicable", arguments: "mcp_resource" },
}

function argumentsComplete(contract: Contract, value: unknown) {
  if (!record(value)) return false
  const input = value
  if (contract.arguments === "project_text_file") return projectTextFileArguments(input)
  if (contract.arguments === "project_literal_grep") return projectLiteralGrepArguments(input)
  if (contract.arguments === "query")
    return exactKeys(input, ["query"]) && typeof input.query === "string" && input.query.length > 0
  if (!exactKeys(input, ["server", "uri"])) return false
  return (
    typeof input.server === "string" && input.server.length > 0 && typeof input.uri === "string" && input.uri.length > 0
  )
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((item) => "value" in item)
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Reflect.ownKeys(value)
  const expected = keys.toSorted()
  return (
    actual.length === expected.length &&
    actual.every((item): item is string => typeof item === "string") &&
    actual.toSorted().every((item, index) => item === expected[index])
  )
}

function projectTextFileArguments(input: Record<string, unknown>) {
  if (
    !exactKeys(input, [
      "bindingId",
      "effects",
      "filePath",
      "instructionFilesAbsent",
      "instructionWatch",
      "limit",
      "mode",
      "offset",
      "target",
    ])
  )
    return false
  if (
    typeof input.filePath !== "string" ||
    input.filePath.length === 0 ||
    typeof input.target !== "string" ||
    input.target.length === 0 ||
    path.isAbsolute(input.target) ||
    path.normalize(input.target) !== input.target ||
    input.target === ".." ||
    input.target.startsWith(`..${path.sep}`) ||
    input.mode !== "pinned-project-text-v4" ||
    typeof input.bindingId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(input.bindingId) ||
    input.instructionFilesAbsent !== true ||
    input.instructionWatch !== "linux-inotify-v1" ||
    !Array.isArray(input.effects) ||
    types.isProxy(input.effects) ||
    input.effects.length !== 0
  )
    return false
  return (
    Number.isSafeInteger(input.offset) &&
    Number(input.offset) > 0 &&
    Number.isSafeInteger(input.limit) &&
    Number(input.limit) > 0
  )
}

function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    !types.isProxy(value) &&
    Reflect.ownKeys(value).every((key) => key === "length" || (typeof key === "string" && /^\d+$/u.test(key))) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((item) => "value" in item) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  )
}

function projectLiteralGrepArguments(input: Record<string, unknown>) {
  if (
    !exactKeys(input, [
      "effects",
      "executor",
      "fileCount",
      "bindingId",
      "limits",
      "literals",
      "mode",
      "path",
      "pattern",
      "totalBytes",
    ])
  )
    return false
  if (!record(input.limits) || !exactKeys(input.limits, ["depth", "fileBytes", "files", "totalBytes"])) return false
  if (
    typeof input.pattern !== "string" ||
    input.pattern.length === 0 ||
    (input.path !== null && typeof input.path !== "string") ||
    input.mode !== "pinned-project-literal-grep-v4" ||
    input.executor !== "literal-utf8-lf-lines-v1" ||
    typeof input.bindingId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(input.bindingId) ||
    !stringArray(input.literals) ||
    input.literals.length > 16 ||
    input.literals.some((item) => item.length > 256 || /[\\.^$*+?()[\]{}\r\n\0|]/u.test(item)) ||
    input.literals.join("|") !== input.pattern ||
    !Array.isArray(input.effects) ||
    types.isProxy(input.effects) ||
    input.effects.length !== 0
  )
    return false
  return (
    Number.isSafeInteger(input.fileCount) &&
    Number(input.fileCount) >= 0 &&
    Number.isSafeInteger(input.totalBytes) &&
    Number(input.totalBytes) >= 0 &&
    input.limits.files === 4096 &&
    input.limits.fileBytes === 8 * 1024 * 1024 &&
    input.limits.totalBytes === 128 * 1024 * 1024 &&
    input.limits.depth === 64 &&
    Number(input.fileCount) <= input.limits.files &&
    Number(input.totalBytes) <= input.limits.totalBytes
  )
}

function requestedArgumentsComplete(contract: Contract, actual: unknown, requested: unknown) {
  if (!argumentsComplete(contract, requested)) return false
  if (!record(actual) || !record(requested)) return false
  if (contract.arguments === "project_text_file") {
    if (
      actual.filePath !== requested.filePath ||
      actual.offset !== requested.offset ||
      actual.limit !== requested.limit
    )
      return false
    return exactKeys(actual, ["filePath", "limit", "offset"])
  }
  if (contract.arguments === "project_literal_grep") {
    if (!exactKeys(actual, actual.path === undefined ? ["pattern"] : ["path", "pattern"])) return false
    return (
      actual.pattern === requested.pattern &&
      (actual.path ?? null) === requested.path &&
      stringArray(requested.literals) &&
      requested.literals.join("|") === actual.pattern
    )
  }
  if (!argumentsComplete(contract, actual)) return false
  // MCP resource tools parse and bind their execution target before plugin hooks run.
  if (contract.arguments === "mcp_resource") return true
  const keys = Object.keys(actual)
  return keys.length === Object.keys(requested).length && keys.every((key) => actual[key] === requested[key])
}

function requestedActionComplete(
  contract: Contract,
  actual: unknown,
  requested: PermissionV1.ReviewAction,
  directory: string,
) {
  if (contract.cwd === "not_applicable") return requested.cwd === null
  if (requested.cwd !== directory || !record(actual)) return false
  if (contract.arguments === "project_literal_grep") {
    if (!record(requested.arguments) || (typeof actual.path !== "string" && actual.path !== undefined)) return false
    const search = path.resolve(directory, actual.path ?? directory)
    return search === directory
  }
  if (contract.arguments !== "project_text_file" || !record(requested.arguments)) return true
  if (typeof actual.filePath !== "string" || typeof requested.arguments.target !== "string") return false
  const filepath = path.isAbsolute(actual.filePath)
    ? path.resolve(actual.filePath)
    : path.resolve(directory, actual.filePath)
  return requested.arguments.target === path.relative(directory, filepath)
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
    if (
      contract &&
      (!record(input.requested) || !exactKeys(input.requested, ["arguments", "complete", "cwd", "identity"]))
    )
      return { identity: input.identity, arguments: input.arguments, complete: false }
    if (input.requested.identity !== input.identity)
      return { identity: input.identity, arguments: input.arguments, complete: false }
    if (contract && !requestedArgumentsComplete(contract, input.arguments, input.requested.arguments))
      return { ...input.requested, complete: false }
    if (contract && !requestedActionComplete(contract, input.arguments, input.requested, input.directory))
      return { ...input.requested, complete: false }
    return input.requested
  }
  if (contract?.requested) return { identity: input.identity, arguments: input.arguments, complete: false }
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
