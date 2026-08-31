import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import path from "node:path"
import { types } from "node:util"
import { exactSearchIncludeTarget } from "@/util/exact-search-include"
import {
  validateExceptionalRiskAssessment,
  validateObviousRiskAssessment,
  type RiskPolicyAssessment,
} from "./reviewer-assessment"

interface Contract {
  readonly permissions: readonly string[]
  readonly cwd: "session" | "not_applicable"
  readonly arguments: "project_text_file" | "project_literal_grep" | "mcp_resource" | "query" | "invocation"
  readonly requested?: boolean
}

const contracts: Readonly<Record<string, Contract>> = {
  grep: { permissions: ["grep"], cwd: "session", arguments: "project_literal_grep", requested: true },
  read: { permissions: ["read"], cwd: "session", arguments: "project_text_file", requested: true },
  websearch: { permissions: ["websearch"], cwd: "not_applicable", arguments: "query" },
  read_mcp_resource: { permissions: ["read"], cwd: "not_applicable", arguments: "mcp_resource" },
  apply_patch: { permissions: ["edit"], cwd: "session", arguments: "invocation" },
  edit: { permissions: ["edit"], cwd: "session", arguments: "invocation" },
  lsp: { permissions: ["lsp"], cwd: "session", arguments: "invocation" },
  skill: { permissions: ["skill"], cwd: "session", arguments: "invocation" },
  task: { permissions: ["task"], cwd: "session", arguments: "invocation" },
  todowrite: { permissions: ["todowrite"], cwd: "not_applicable", arguments: "invocation" },
  webfetch: { permissions: ["webfetch"], cwd: "not_applicable", arguments: "invocation" },
  write: { permissions: ["edit"], cwd: "session", arguments: "invocation" },
}

const externalDirectoryContracts: Readonly<Record<string, Contract>> = {
  glob: { permissions: ["external_directory"], cwd: "session", arguments: "invocation" },
  grep: { permissions: ["external_directory"], cwd: "session", arguments: "invocation" },
  read: { permissions: ["external_directory"], cwd: "session", arguments: "invocation" },
}

const invocationContract = "registered-builtin-invocation-v1"
const boundExternalSearchContract = "pinned-external-search-v1"
const boundProjectSearchContract = "pinned-project-search-v1"
const boundExternalReadContract = "pinned-external-text-v1"

function argumentsComplete(contract: Contract, value: unknown) {
  if (!record(value)) return false
  const input = value
  if (contract.arguments === "project_text_file") return projectTextFileArguments(input)
  if (contract.arguments === "project_literal_grep") return projectLiteralGrepArguments(input)
  if (contract.arguments === "query")
    return exactKeys(input, ["query"]) && typeof input.query === "string" && input.query.length > 0
  if (contract.arguments === "invocation")
    return (
      exactKeys(input, ["contract", "effects_bound", "invocation"]) &&
      input.contract === invocationContract &&
      input.effects_bound === false &&
      record(input.invocation)
    )
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

function readonlyInvocationArguments(identity: string, value: unknown) {
  if (!record(value)) return false
  if (identity === "glob") {
    if (!exactKeys(value, value.path === undefined ? ["pattern"] : ["path", "pattern"])) return false
    return (
      typeof value.pattern === "string" &&
      value.pattern.length > 0 &&
      (value.path === undefined || (typeof value.path === "string" && value.path.length > 0))
    )
  }
  if (identity === "grep") {
    const keys = [
      "pattern",
      ...(value.path === undefined ? [] : ["path"]),
      ...(value.include === undefined ? [] : ["include"]),
    ]
    if (!exactKeys(value, keys)) return false
    return (
      typeof value.pattern === "string" &&
      value.pattern.length > 0 &&
      (value.path === undefined || (typeof value.path === "string" && value.path.length > 0)) &&
      (value.include === undefined || (typeof value.include === "string" && value.include.length > 0))
    )
  }
  if (identity !== "read") return false
  const keys = [
    "filePath",
    ...(value.offset === undefined ? [] : ["offset"]),
    ...(value.limit === undefined ? [] : ["limit"]),
  ]
  if (!exactKeys(value, keys) || typeof value.filePath !== "string" || value.filePath.length === 0) return false
  return (
    (value.offset === undefined || (Number.isSafeInteger(value.offset) && Number(value.offset) >= 0)) &&
    (value.limit === undefined || (Number.isSafeInteger(value.limit) && Number(value.limit) >= 0))
  )
}

function sameReadonlyInvocation(identity: string, left: unknown, right: unknown) {
  if (!readonlyInvocationArguments(identity, left) || !readonlyInvocationArguments(identity, right)) return false
  if (!record(left) || !record(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

function boundExternalSearchArguments(identity: string, value: unknown) {
  if (identity !== "grep" || !record(value)) return false
  if (
    !exactKeys(value, ["bindingId", "contract", "effects", "executor", "invocation", "kind", "mode"]) ||
    value.contract !== boundExternalSearchContract ||
    value.mode !== "bound" ||
    typeof value.bindingId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.bindingId) ||
    !Array.isArray(value.effects) ||
    types.isProxy(value.effects) ||
    value.effects.length !== 0 ||
    !readonlyInvocationArguments(identity, value.invocation)
  )
    return false
  return value.kind === "file" && value.executor === "ripgrep-inherited-readonly-fd-v1"
}

function boundProjectSearchArguments(identity: string, value: unknown) {
  if ((identity !== "glob" && identity !== "grep") || !record(value)) return false
  if (
    !exactKeys(value, ["bindingId", "contract", "effects", "executor", "invocation", "mode", "tool"]) ||
    value.contract !== boundProjectSearchContract ||
    value.mode !== "directory" ||
    value.tool !== identity ||
    value.executor !== "ripgrep-procfd-cwd-v1" ||
    typeof value.bindingId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.bindingId) ||
    !Array.isArray(value.effects) ||
    types.isProxy(value.effects) ||
    value.effects.length !== 0 ||
    !readonlyInvocationArguments(identity, value.invocation)
  )
    return false
  return true
}

function boundProjectSearchScope(identity: string, value: unknown, directory: string, cwd: unknown) {
  if (!boundProjectSearchArguments(identity, value) || !record(value) || !record(value.invocation)) return false
  if (!path.isAbsolute(directory) || typeof cwd !== "string" || !path.isAbsolute(cwd)) return false
  const raw = value.invocation.path ?? directory
  if (typeof raw !== "string" || raw.length === 0) return false
  const target = path.resolve(directory, raw)
  return contains(directory, target) && cwd === target
}

function boundExternalReadArguments(identity: string, value: unknown) {
  if (identity !== "read" || !record(value)) return false
  return (
    exactKeys(value, ["bindingId", "contract", "effects", "invocation", "mode"]) &&
    value.contract === boundExternalReadContract &&
    value.mode === "bound" &&
    typeof value.bindingId === "string" &&
    /^[0-9a-f]{32}$/u.test(value.bindingId) &&
    Array.isArray(value.effects) &&
    !types.isProxy(value.effects) &&
    value.effects.length === 0 &&
    readonlyInvocationArguments(identity, value.invocation)
  )
}

function boundExternalSearchRequested(input: {
  readonly permission?: string
  readonly identity: string
  readonly arguments: unknown
  readonly directory: string
  readonly requested: PermissionV1.ReviewAction
}) {
  const requested = input.requested
  if (
    input.identity !== "grep" ||
    input.permission !== input.identity ||
    requested.identity !== input.identity ||
    requested.complete !== true ||
    typeof requested.cwd !== "string" ||
    !path.isAbsolute(requested.cwd) ||
    !boundExternalSearchArguments(input.identity, requested.arguments) ||
    !record(requested.arguments) ||
    !sameReadonlyInvocation(input.identity, input.arguments, requested.arguments.invocation) ||
    !record(input.arguments)
  )
    return false
  const raw = input.arguments.path ?? input.directory
  if (typeof raw !== "string" || raw.length === 0) return false
  const rawTarget = path.resolve(input.directory, raw)
  const includedTarget = exactSearchIncludeTarget(input.arguments, input.directory)
  const target = includedTarget && requested.cwd === path.dirname(includedTarget) ? includedTarget : rawTarget
  if (contains(input.directory, target)) return false
  return requested.arguments.kind === "file" && requested.cwd === path.dirname(target)
}

function boundProjectSearchRequested(input: {
  readonly permission?: string
  readonly identity: string
  readonly arguments: unknown
  readonly directory: string
  readonly requested: PermissionV1.ReviewAction
}) {
  const requested = input.requested
  if (
    (input.identity !== "glob" && input.identity !== "grep") ||
    input.permission !== input.identity ||
    requested.identity !== input.identity ||
    requested.complete !== true ||
    typeof requested.cwd !== "string" ||
    !path.isAbsolute(requested.cwd) ||
    !boundProjectSearchArguments(input.identity, requested.arguments) ||
    !record(requested.arguments) ||
    !sameReadonlyInvocation(input.identity, input.arguments, requested.arguments.invocation) ||
    !record(input.arguments)
  )
    return false
  return boundProjectSearchScope(input.identity, requested.arguments, input.directory, requested.cwd)
}

function boundExternalReadRequested(input: {
  readonly permission?: string
  readonly permissionMetadata?: Record<string, unknown>
  readonly identity: string
  readonly arguments: unknown
  readonly directory: string
  readonly requested: PermissionV1.ReviewAction
}) {
  const requested = input.requested
  if (
    input.identity !== "read" ||
    input.permission !== "read" ||
    requested.identity !== "read" ||
    requested.complete !== true ||
    typeof requested.cwd !== "string" ||
    !path.isAbsolute(requested.cwd) ||
    !boundExternalReadArguments(input.identity, requested.arguments) ||
    !record(requested.arguments) ||
    !sameReadonlyInvocation(input.identity, input.arguments, requested.arguments.invocation) ||
    !record(input.arguments) ||
    !primaryReadBindingMetadata(input.permissionMetadata)
  )
    return false
  const metadataBinding = input.permissionMetadata?.readBinding
  if (!record(metadataBinding) || requested.arguments.bindingId !== metadataBinding.bindingId) return false
  const raw = input.arguments.filePath
  if (typeof raw !== "string" || raw.length === 0) return false
  const target = path.resolve(input.directory, raw)
  return !contains(input.directory, target) && requested.cwd === path.dirname(target)
}

function primaryReadBindingMetadata(value: unknown) {
  if (
    !record(value) ||
    !exactKeys(value, ["readBinding", "readScope"]) ||
    !record(value.readBinding) ||
    !record(value.readScope)
  )
    return false
  const binding = value.readBinding
  const scope = value.readScope
  return (
    exactKeys(binding, ["bindingId", "contract", "version"]) &&
    binding.version === 1 &&
    binding.contract === boundExternalReadContract &&
    typeof binding.bindingId === "string" &&
    /^[0-9a-f]{32}$/u.test(binding.bindingId) &&
    exactKeys(scope, [
      "canonicalRoot",
      "canonicalTarget",
      "kind",
      "rootDevice",
      "rootInode",
      "targetDevice",
      "targetInode",
      "version",
    ]) &&
    scope.version === 1 &&
    scope.kind === "file" &&
    typeof scope.canonicalTarget === "string" &&
    typeof scope.canonicalRoot === "string" &&
    typeof scope.targetDevice === "string" &&
    typeof scope.targetInode === "string" &&
    typeof scope.rootDevice === "string" &&
    typeof scope.rootInode === "string" &&
    path.dirname(scope.canonicalTarget) === scope.canonicalRoot
  )
}

function externalSearchBindingMetadata(value: unknown, identity: string) {
  if (identity !== "grep" || !record(value)) return false
  const binding = value.searchBinding
  const scope = value.readScope
  if (
    !exactKeys(value, ["filepath", "parentDir", "readScope", "searchBinding", "tool"]) ||
    value.tool !== identity ||
    !record(binding) ||
    !record(scope) ||
    !exactKeys(scope, [
      "canonicalRoot",
      "canonicalTarget",
      "kind",
      "rootDevice",
      "rootInode",
      "targetDevice",
      "targetInode",
      "version",
    ]) ||
    scope.version !== 1 ||
    scope.kind !== "file" ||
    typeof scope.canonicalTarget !== "string" ||
    typeof scope.canonicalRoot !== "string" ||
    typeof scope.targetDevice !== "string" ||
    typeof scope.targetInode !== "string" ||
    typeof scope.rootDevice !== "string" ||
    typeof scope.rootInode !== "string" ||
    value.filepath !== scope.canonicalTarget ||
    value.parentDir !== scope.canonicalRoot
  )
    return false
  return (
    exactKeys(binding, ["bindingId", "contract", "effects", "executor", "mode", "version"]) &&
    binding.version === 1 &&
    binding.contract === boundExternalSearchContract &&
    typeof binding.bindingId === "string" &&
    /^[0-9a-f]{32}$/u.test(binding.bindingId) &&
    Array.isArray(binding.effects) &&
    !types.isProxy(binding.effects) &&
    binding.effects.length === 0 &&
    binding.mode === "file" &&
    binding.executor === "ripgrep-inherited-readonly-fd-v1"
  )
}

function externalReadBindingMetadata(value: unknown) {
  if (!record(value) || !exactKeys(value, ["filepath", "parentDir", "readBinding", "readScope", "tool"])) return false
  const binding = value.readBinding
  const scope = value.readScope
  if (
    value.tool !== "read" ||
    !record(binding) ||
    !record(scope) ||
    !exactKeys(binding, ["bindingId", "contract", "version"]) ||
    binding.version !== 1 ||
    binding.contract !== "pinned-external-text-v1" ||
    typeof binding.bindingId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(binding.bindingId) ||
    !exactKeys(scope, [
      "canonicalRoot",
      "canonicalTarget",
      "kind",
      "rootDevice",
      "rootInode",
      "targetDevice",
      "targetInode",
      "version",
    ]) ||
    scope.version !== 1 ||
    scope.kind !== "file" ||
    typeof scope.canonicalTarget !== "string" ||
    typeof scope.canonicalRoot !== "string" ||
    typeof scope.targetDevice !== "string" ||
    typeof scope.targetInode !== "string" ||
    typeof scope.rootDevice !== "string" ||
    typeof scope.rootInode !== "string" ||
    !path.isAbsolute(scope.canonicalTarget) ||
    !path.isAbsolute(scope.canonicalRoot)
  )
    return false
  return (
    value.filepath === scope.canonicalTarget &&
    value.parentDir === scope.canonicalRoot &&
    path.dirname(scope.canonicalTarget) === scope.canonicalRoot
  )
}

export function registeredReadonlyInvocation(action: PermissionReviewSnapshot["action"]) {
  if (action.identity !== "glob" && action.identity !== "grep" && action.identity !== "read") return
  const contract = { permissions: [action.identity], cwd: "session", arguments: "invocation" } satisfies Contract
  if (!record(action.arguments)) return
  const invocation =
    argumentsComplete(contract, action.arguments) ||
    boundExternalSearchArguments(action.identity, action.arguments) ||
    boundProjectSearchArguments(action.identity, action.arguments) ||
    boundExternalReadArguments(action.identity, action.arguments)
      ? action.arguments.invocation
      : undefined
  if (!readonlyInvocationArguments(action.identity, invocation) || !record(invocation)) return
  return { identity: action.identity as "glob" | "grep" | "read", invocation }
}

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function metadataTool(value: unknown) {
  if (!record(value)) return
  const descriptor = Object.getOwnPropertyDescriptor(value, "tool")
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined
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
  readonly permission?: string
  readonly permissionMetadata?: Record<string, unknown>
  readonly identity: string
  readonly arguments: unknown
  readonly directory: string
  readonly requested?: PermissionV1.ReviewAction
}): PermissionV1.ReviewAction {
  if (!input.builtin) return { identity: input.identity, arguments: input.arguments, complete: false }
  const externalIdentity =
    input.permission === "external_directory" ? metadataTool(input.permissionMetadata) : undefined
  const externalContractExpected =
    input.permission === "external_directory" && Object.hasOwn(externalDirectoryContracts, input.identity)
  const contractIdentity = input.permission === "external_directory" ? externalIdentity : input.identity
  const contract =
    contractIdentity === input.identity
      ? input.permission === "external_directory"
        ? externalDirectoryContracts[contractIdentity]
        : contracts[contractIdentity]
      : undefined
  if (
    input.permission === "external_directory" &&
    (externalIdentity === "glob" || externalIdentity === "grep") &&
    !externalSearchBindingMetadata(input.permissionMetadata, externalIdentity)
  )
    return { identity: input.identity, arguments: input.arguments, complete: false }
  if (
    input.permission === "external_directory" &&
    externalIdentity === "read" &&
    !externalReadBindingMetadata(input.permissionMetadata)
  )
    return { identity: input.identity, arguments: input.arguments, complete: false }
  if (input.requested) {
    const boundExternalSearch = boundExternalSearchRequested({ ...input, requested: input.requested })
    if (boundExternalSearch) return input.requested
    const boundProjectSearch = boundProjectSearchRequested({ ...input, requested: input.requested })
    if (boundProjectSearch) return input.requested
    const boundExternalRead = boundExternalReadRequested({ ...input, requested: input.requested })
    if (boundExternalRead) return input.requested
    if (
      (input.identity === "glob" || input.identity === "grep") &&
      typeof input.requested.cwd === "string" &&
      path.isAbsolute(input.requested.cwd) &&
      !contains(input.directory, input.requested.cwd)
    )
      return { identity: input.identity, arguments: input.arguments, complete: false }
    if (externalContractExpected && !contract)
      return { identity: input.identity, arguments: input.arguments, complete: false }
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
    if (!contract)
      return input.identity === "read" || input.identity === "glob" || input.identity === "grep"
        ? { ...input.requested, complete: false }
        : input.requested
    return input.requested
  }
  if (contract?.requested) return { identity: input.identity, arguments: input.arguments, complete: false }
  if (!contract) return { identity: input.identity, arguments: input.arguments, complete: false }
  const arguments_ =
    contract.arguments === "invocation"
      ? { contract: invocationContract, effects_bound: false, invocation: input.arguments }
      : input.arguments
  if (!argumentsComplete(contract, arguments_))
    return { identity: input.identity, arguments: input.arguments, complete: false }
  return {
    identity: input.identity,
    arguments: arguments_,
    cwd: contract.cwd === "session" ? input.directory : null,
    complete: true,
  }
}

type GenericRiskInput = {
  readonly settled: boolean
  readonly permission: string
  readonly assessment: RiskPolicyAssessment
  readonly snapshot: PermissionReviewSnapshot
  readonly policy?: "obvious-risk-only-v1" | "exceptional-risk-only-v1"
  readonly directory?: string
  readonly allowExternalReadScope?: boolean
}

export type GenericRiskCandidateRejection =
  | "review_unsettled"
  | "assessment_invalid"
  | "contract_unknown"
  | "action_incomplete"
  | "action_scope_invalid"
  | "authority_action_changed"
  | "authority_evidence_changed"
  | "authority_revoked"
  | "authority_turn_changed"
  | "context_unsafe"
  | "trusted_evidence_incomplete"

export function genericRiskCandidateRejection(input: GenericRiskInput): GenericRiskCandidateRejection | undefined {
  const action = input.snapshot.action
  const boundExternal = boundExternalSearchArguments(action.identity, action.arguments)
  const boundProject = boundProjectSearchArguments(action.identity, action.arguments)
  const boundRead = boundExternalReadArguments(action.identity, action.arguments)
  const specialised = contracts[action.identity]
  const contract =
    boundExternal || boundProject || boundRead
      ? ({ permissions: [action.identity], cwd: "session", arguments: "invocation" } satisfies Contract)
      : specialised
  if (!contract) return "contract_unknown"
  const validated =
    input.policy === "exceptional-risk-only-v1"
      ? validateExceptionalRiskAssessment(input.assessment)
      : validateObviousRiskAssessment(input.assessment)
  const cwdComplete =
    contract.cwd === "not_applicable"
      ? action.cwd_status === "not_applicable"
      : action.cwd_status === "exact" && typeof action.cwd === "string" && action.cwd.length > 0
  const trusted = input.snapshot.trusted
  if (!input.settled) return "review_unsettled"
  if ("failure" in validated) return "assessment_invalid"
  if (
    !contract.permissions.includes(input.permission) ||
    action.permission !== input.permission ||
    action.origin !== "tool" ||
    !action.complete ||
    action.omitted_items !== 0 ||
    action.omitted_bytes !== 0 ||
    !(boundExternal || boundProject || boundRead || argumentsComplete(contract, action.arguments)) ||
    !cwdComplete
  )
    return "action_incomplete"
  if (boundExternal) {
    if (
      typeof input.directory !== "string" ||
      !path.isAbsolute(input.directory) ||
      typeof action.cwd !== "string" ||
      contains(input.directory, action.cwd)
    )
      return "action_scope_invalid"
  } else if (boundProject) {
    if (
      typeof input.directory !== "string" ||
      !boundProjectSearchScope(action.identity, action.arguments, input.directory, action.cwd)
    )
      return "action_scope_invalid"
  } else if (boundRead) {
    if (
      typeof input.directory !== "string" ||
      !path.isAbsolute(input.directory) ||
      typeof action.cwd !== "string" ||
      contains(input.directory, action.cwd) ||
      input.allowExternalReadScope !== true
    )
      return "action_scope_invalid"
  }
  if (!input.snapshot.context_safe_for_gate) return "context_unsafe"
  if (
    !trusted.complete ||
    trusted.omitted_items !== 0 ||
    trusted.omitted_bytes !== 0 ||
    trusted.items.length === 0 ||
    trusted.items.some((item) => item.source !== "human" || !item.trusted)
  )
    return "trusted_evidence_incomplete"
}

export function isGenericRiskCandidate(input: GenericRiskInput) {
  return genericRiskCandidateRejection(input) === undefined
}

export function isGenericRiskAllowCandidate(input: Parameters<typeof isGenericRiskCandidate>[0]) {
  return input.assessment.outcome === "allow" && isGenericRiskCandidate(input)
}

export function isCompleteExternalDirectoryBashAction(action: PermissionReviewSnapshot["action"]) {
  if (action.identity !== "bash") return false
  const value = action.arguments
  const cwd = action.cwd
  if (!record(value) || !exactKeys(value, ["command", "shell", "timeout", "workdir"])) return false
  return (
    typeof value.command === "string" &&
    value.command.length > 0 &&
    typeof value.shell === "string" &&
    value.shell.length > 0 &&
    Number.isSafeInteger(value.timeout) &&
    Number(value.timeout) > 0 &&
    typeof value.workdir === "string" &&
    value.workdir.length > 0 &&
    value.workdir === cwd
  )
}

export function isExternalDirectoryRiskAllowCandidate(input: Parameters<typeof isGenericRiskCandidate>[0]) {
  if (input.permission !== "external_directory" || input.assessment.outcome !== "allow") return false
  const action = input.snapshot.action
  const contract = externalDirectoryContracts[action.identity]
  const validated =
    input.policy === "exceptional-risk-only-v1"
      ? validateExceptionalRiskAssessment(input.assessment)
      : validateObviousRiskAssessment(input.assessment)
  const trusted = input.snapshot.trusted
  const argumentsValid = contract
    ? argumentsComplete(contract, action.arguments) && registeredReadonlyInvocation(action) !== undefined
    : isCompleteExternalDirectoryBashAction(action)
  return (
    input.settled &&
    !("failure" in validated) &&
    action.permission === "external_directory" &&
    action.origin === "tool" &&
    (action.identity === "read" ||
      action.identity === "grep" ||
      action.identity === "glob" ||
      action.identity === "bash") &&
    action.complete &&
    action.omitted_items === 0 &&
    action.omitted_bytes === 0 &&
    argumentsValid &&
    action.cwd_status === "exact" &&
    typeof action.cwd === "string" &&
    action.cwd.length > 0 &&
    path.isAbsolute(action.cwd) &&
    (action.identity !== "bash" || input.policy === "exceptional-risk-only-v1") &&
    input.snapshot.context_safe_for_gate &&
    trusted.complete &&
    trusted.omitted_items === 0 &&
    trusted.omitted_bytes === 0 &&
    trusted.items.length > 0 &&
    trusted.items.every((item) => item.source === "human" && item.trusted)
  )
}
