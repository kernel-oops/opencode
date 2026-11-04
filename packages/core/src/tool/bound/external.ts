export * as BoundExternal from "./external.js"

import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { FileAccess } from "../../file-access.js"
import { BoundExternalFile } from "@opencode/util/bound/external-file"

export type Kind = "file" | "directory"
export type Tool = "read" | "grep" | "glob"

export interface Identity {
  readonly targetDevice: string
  readonly targetInode: string
  readonly rootDevice: string
  readonly rootInode: string
}

export interface ReadScope extends Identity {
  readonly version: 1
  readonly canonicalTarget: string
  readonly canonicalRoot: string
  readonly kind: Kind
}

export interface ReadBinding {
  readonly version: 1
  readonly contract: "pinned-external-text-v1"
  readonly bindingId: string
}

export interface SearchBinding {
  readonly version: 1
  readonly contract: "pinned-external-search-v1"
  readonly mode: "file"
  readonly executor: "ripgrep-bound-description-v1"
  readonly bindingId: string
  readonly effects: readonly []
}

/** Identity captured before review of an external target; `verify` fails closed if it changed afterwards. */
export interface Scope {
  readonly version: 1
  readonly tool: Tool
  readonly lexicalTarget: string
  readonly canonicalTarget?: string
  readonly canonicalRoot?: string
  readonly kind: Kind
  readonly targetDevice?: number
  readonly targetInode?: number
  readonly rootDevice?: number
  readonly rootInode?: number
  readonly readScope?: ReadScope
  readonly readBinding?: ReadBinding
  readonly boundRead?: BoundExternalFile.Bound
  readonly searchBinding?: SearchBinding
}

export interface Options {
  readonly kind: Kind
  readonly tool: Tool
  /** Pin the external text file behind a read-only descriptor for the whole invocation. */
  readonly bindRead?: boolean
  readonly searchBinding?: SearchBinding
  readonly scopeIdentity?: Identity
}

export const kindOf = (target: FileAccess.Target): Kind =>
  target.externalDirectory?.directory === target.absolute ? "directory" : "file"

const attempt = <A>(work: () => Promise<A>) => work().catch(() => undefined)

/** Inspect an external target. Returns undefined for internal targets or unsupported platforms. */
export async function inspect(target: FileAccess.Target, options: Options): Promise<Scope | undefined> {
  if (!target.externalDirectory) return undefined
  const lexical = path.resolve(target.absolute)
  const resolved = await attempt(() => realpath(lexical))
  const full = resolved ?? lexical
  const kind = options.kind
  const dir = kind === "directory" ? full : path.dirname(full)
  const info = resolved ? await attempt(() => stat(full)) : undefined
  const root = resolved ? await attempt(() => realpath(dir)) : undefined
  const rootInfo = root ? await attempt(() => stat(root)) : undefined
  const candidate =
    process.platform === "linux" &&
    resolved !== undefined &&
    resolved === lexical &&
    root !== undefined &&
    root === dir &&
    rootInfo?.isDirectory() &&
    ((kind === "directory" && info?.isDirectory()) || (kind === "file" && info?.isFile()))
      ? { canonicalTarget: resolved, canonicalRoot: root, kind }
      : undefined
  const candidateBoundRead =
    candidate && options.bindRead === true && options.tool === "read" && kind === "file"
      ? await BoundExternalFile.bind(candidate.canonicalTarget)
      : undefined
  const identity =
    options.scopeIdentity ??
    (candidateBoundRead
      ? {
          targetDevice: candidateBoundRead.fileGeneration.dev.toString(),
          targetInode: candidateBoundRead.fileGeneration.ino.toString(),
          rootDevice: candidateBoundRead.rootGeneration.dev.toString(),
          rootInode: candidateBoundRead.rootGeneration.ino.toString(),
        }
      : undefined)
  const readScope: ReadScope | undefined =
    candidate &&
    identity &&
    info &&
    rootInfo &&
    identity.targetDevice === String(info.dev) &&
    identity.targetInode === String(info.ino) &&
    identity.rootDevice === String(rootInfo.dev) &&
    identity.rootInode === String(rootInfo.ino)
      ? { version: 1, ...candidate, ...identity }
      : undefined
  if (candidateBoundRead && !readScope) await BoundExternalFile.close(candidateBoundRead)
  const boundRead = readScope && candidateBoundRead ? candidateBoundRead : undefined
  const readBinding: ReadBinding | undefined = boundRead
    ? { version: 1, contract: "pinned-external-text-v1", bindingId: boundRead.bindingId }
    : undefined
  const searchBinding =
    readScope &&
    options.tool === "grep" &&
    kind === "file" &&
    options.searchBinding?.version === 1 &&
    options.searchBinding.contract === "pinned-external-search-v1" &&
    /^[0-9a-f]{32}$/u.test(options.searchBinding.bindingId) &&
    options.searchBinding.effects.length === 0 &&
    options.searchBinding.mode === "file" &&
    options.searchBinding.executor === "ripgrep-bound-description-v1"
      ? options.searchBinding
      : undefined
  return {
    version: 1,
    tool: options.tool,
    lexicalTarget: lexical,
    canonicalTarget: resolved,
    canonicalRoot: root,
    kind,
    targetDevice: info?.dev,
    targetInode: info?.ino,
    rootDevice: rootInfo?.dev,
    rootInode: rootInfo?.ino,
    ...(readScope ? { readScope } : {}),
    ...(readBinding ? { readBinding } : {}),
    ...(boundRead ? { boundRead } : {}),
    ...(searchBinding ? { searchBinding } : {}),
  }
}

/** Metadata attached to the `external_directory` permission request so a reviewer can see the exact bound scope. */
export function metadata(scope: Scope | undefined): Record<string, unknown> | undefined {
  if (!scope) return undefined
  const full = scope.canonicalTarget ?? scope.lexicalTarget
  return {
    filepath: full,
    parentDir: scope.kind === "directory" ? full : path.dirname(full),
    tool: scope.tool,
    ...(scope.readScope ? { readScope: scope.readScope } : {}),
    ...(scope.readBinding ? { readBinding: scope.readBinding } : {}),
    ...(scope.searchBinding ? { searchBinding: scope.searchBinding } : {}),
  }
}

export class ChangedError extends Error {
  constructor() {
    super("External path changed after permission review")
    this.name = "BoundExternal.ChangedError"
  }
}

const changed = () => Effect.fail(new ChangedError())

/** Re-check the reviewed identity after approval; a swapped, moved or re-linked target fails closed. */
export const verify = Effect.fn("BoundExternal.verify")(function* (scope: Scope | undefined) {
  if (!scope) return
  if (
    scope.canonicalTarget === undefined ||
    scope.canonicalRoot === undefined ||
    scope.targetDevice === undefined ||
    scope.targetInode === undefined ||
    scope.rootDevice === undefined ||
    scope.rootInode === undefined
  )
    return yield* changed()
  const reviewedRoot = scope.canonicalRoot
  const canonicalTarget = yield* Effect.tryPromise(() => realpath(scope.lexicalTarget)).pipe(
    Effect.mapError(() => new ChangedError()),
  )
  const canonicalRoot = yield* Effect.tryPromise(() => realpath(reviewedRoot)).pipe(
    Effect.mapError(() => new ChangedError()),
  )
  const targetInfo = yield* Effect.tryPromise(() => stat(canonicalTarget)).pipe(
    Effect.mapError(() => new ChangedError()),
  )
  const rootInfo = yield* Effect.tryPromise(() => stat(canonicalRoot)).pipe(Effect.mapError(() => new ChangedError()))
  const relative = path.relative(canonicalRoot, canonicalTarget)
  const contained =
    relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  const exactScope = scope.readScope
    ? scope.readScope.version === 1 &&
      scope.readScope.canonicalTarget === scope.canonicalTarget &&
      scope.readScope.canonicalRoot === scope.canonicalRoot &&
      scope.readScope.kind === scope.kind &&
      scope.readScope.targetDevice === String(scope.targetDevice) &&
      scope.readScope.targetInode === String(scope.targetInode) &&
      scope.readScope.rootDevice === String(scope.rootDevice) &&
      scope.readScope.rootInode === String(scope.rootInode) &&
      scope.lexicalTarget === scope.canonicalTarget
    : true
  const exactBinding = scope.readBinding
    ? scope.boundRead !== undefined &&
      scope.readBinding.version === 1 &&
      scope.readBinding.contract === "pinned-external-text-v1" &&
      scope.readBinding.bindingId === scope.boundRead.bindingId &&
      scope.boundRead.path === scope.canonicalTarget &&
      scope.boundRead.rootPath === scope.canonicalRoot
    : scope.boundRead === undefined
  if (
    canonicalTarget !== scope.canonicalTarget ||
    canonicalRoot !== scope.canonicalRoot ||
    !contained ||
    !rootInfo.isDirectory() ||
    (scope.kind === "directory" ? !targetInfo.isDirectory() : !targetInfo.isFile()) ||
    targetInfo.dev !== scope.targetDevice ||
    targetInfo.ino !== scope.targetInode ||
    rootInfo.dev !== scope.rootDevice ||
    rootInfo.ino !== scope.rootInode ||
    !exactScope ||
    !exactBinding
  )
    return yield* changed()
  return undefined
})

export async function release(scope: Scope | undefined) {
  if (scope?.boundRead) await BoundExternalFile.close(scope.boundRead)
}
