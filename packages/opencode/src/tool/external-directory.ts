import path from "path"
import { realpath, stat } from "node:fs/promises"
import { Effect, Exit } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import {
  bindExternalTextFile,
  closeBoundExternalTextFile,
  type BoundExternalTextFile,
} from "./external-read-bound-file"

type Kind = "file" | "directory"

type ScopeIdentity = {
  readonly targetDevice: string
  readonly targetInode: string
  readonly rootDevice: string
  readonly rootInode: string
}

type Options = {
  bypass?: boolean
  bindRead?: boolean
  kind?: Kind
  tool?: "glob" | "grep" | "read"
  scopeIdentity?: ScopeIdentity
  searchBinding?: {
    readonly version: 1
    readonly contract: "pinned-external-search-v1"
    readonly mode: "file"
    readonly executor: "ripgrep-inherited-readonly-fd-v1"
    readonly bindingId: string
    readonly effects: readonly []
  }
}

export type ExternalDirectoryVerification =
  | false
  | {
      readonly version: 1
      readonly lexicalTarget: string
      readonly canonicalTarget?: string
      readonly canonicalRoot?: string
      readonly kind: Kind
      readonly targetDevice?: number
      readonly targetInode?: number
      readonly rootDevice?: number
      readonly rootInode?: number
      readonly readScope?: {
        readonly version: 1
        readonly canonicalTarget: string
        readonly canonicalRoot: string
        readonly kind: Kind
        readonly targetDevice: string
        readonly targetInode: string
        readonly rootDevice: string
        readonly rootInode: string
      }
      readonly readBinding?: {
        readonly version: 1
        readonly contract: "pinned-external-text-v1"
        readonly bindingId: string
      }
      readonly boundRead?: BoundExternalTextFile
      readonly searchBinding?: Options["searchBinding"]
    }

const changed = () => Effect.fail(new Error("External path changed after permission review"))

export const verifyExternalDirectoryEffect = Effect.fn("Tool.verifyExternalDirectory")(function* (
  verification: ExternalDirectoryVerification,
) {
  if (!verification) return
  if (
    verification.canonicalTarget === undefined ||
    verification.canonicalRoot === undefined ||
    verification.targetDevice === undefined ||
    verification.targetInode === undefined ||
    verification.rootDevice === undefined ||
    verification.rootInode === undefined
  )
    return yield* changed()

  const reviewedTarget = verification.canonicalTarget
  const reviewedRoot = verification.canonicalRoot
  const canonicalTarget = yield* Effect.tryPromise(() => realpath(verification.lexicalTarget)).pipe(
    Effect.mapError(() => new Error("External path changed after permission review")),
  )
  const canonicalRoot = yield* Effect.tryPromise(() => realpath(reviewedRoot)).pipe(
    Effect.mapError(() => new Error("External path changed after permission review")),
  )
  const targetInfo = yield* Effect.tryPromise(() => stat(canonicalTarget)).pipe(
    Effect.mapError(() => new Error("External path changed after permission review")),
  )
  const rootInfo = yield* Effect.tryPromise(() => stat(canonicalRoot)).pipe(
    Effect.mapError(() => new Error("External path changed after permission review")),
  )
  const relative = path.relative(canonicalRoot, canonicalTarget)
  const contained =
    relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  const exactScope = verification.readScope
    ? verification.readScope.version === 1 &&
      verification.readScope.canonicalTarget === verification.canonicalTarget &&
      verification.readScope.canonicalRoot === verification.canonicalRoot &&
      verification.readScope.kind === verification.kind &&
      verification.readScope.targetDevice === String(verification.targetDevice) &&
      verification.readScope.targetInode === String(verification.targetInode) &&
      verification.readScope.rootDevice === String(verification.rootDevice) &&
      verification.readScope.rootInode === String(verification.rootInode) &&
      verification.lexicalTarget === verification.canonicalTarget
    : true
  const exactBinding = verification.readBinding
    ? verification.boundRead !== undefined &&
      verification.readBinding.version === 1 &&
      verification.readBinding.contract === "pinned-external-text-v1" &&
      verification.readBinding.bindingId === verification.boundRead.bindingId &&
      verification.boundRead.path === verification.canonicalTarget &&
      verification.boundRead.rootPath === verification.canonicalRoot
    : verification.boundRead === undefined
  if (
    canonicalTarget !== verification.canonicalTarget ||
    canonicalRoot !== verification.canonicalRoot ||
    !contained ||
    !rootInfo.isDirectory() ||
    (verification.kind === "directory" ? !targetInfo.isDirectory() : !targetInfo.isFile()) ||
    targetInfo.dev !== verification.targetDevice ||
    targetInfo.ino !== verification.targetInode ||
    rootInfo.dev !== verification.rootDevice ||
    rootInfo.ino !== verification.rootInode ||
    !exactScope ||
    !exactBinding
  )
    return yield* changed()
})

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false as const

  if (options?.bypass) return false as const

  const ins = yield* InstanceState.context
  const lexical = path.resolve(target)
  const resolved = yield* Effect.tryPromise(() => realpath(lexical)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const full = process.platform === "win32" ? FSUtil.normalizePath(resolved ?? lexical) : (resolved ?? lexical)
  if (containsPath(full, ins)) return false as const

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const info = resolved
    ? yield* Effect.tryPromise(() => stat(full)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    : undefined
  const root = resolved
    ? yield* Effect.tryPromise(() => realpath(dir)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    : undefined
  const rootInfo = root
    ? yield* Effect.tryPromise(() => stat(root)).pipe(Effect.catch(() => Effect.succeed(undefined)))
    : undefined
  const scopeCandidate =
    process.platform === "linux" &&
    options?.tool !== undefined &&
    resolved !== undefined &&
    resolved === lexical &&
    root !== undefined &&
    root === dir &&
    rootInfo?.isDirectory() &&
    ((kind === "directory" && info?.isDirectory()) || (kind === "file" && info?.isFile()))
      ? { canonicalTarget: resolved, canonicalRoot: root, kind }
      : undefined
  const candidateBoundRead =
    scopeCandidate && options?.bindRead === true && options.tool === "read" && kind === "file"
      ? yield* Effect.promise(() => bindExternalTextFile(scopeCandidate.canonicalTarget))
      : undefined
  const scopeIdentity =
    options?.scopeIdentity ??
    (candidateBoundRead
      ? {
          targetDevice: candidateBoundRead.fileGeneration.dev.toString(),
          targetInode: candidateBoundRead.fileGeneration.ino.toString(),
          rootDevice: candidateBoundRead.rootGeneration.dev.toString(),
          rootInode: candidateBoundRead.rootGeneration.ino.toString(),
        }
      : undefined)
  const readScope =
    scopeCandidate &&
    scopeIdentity &&
    info &&
    rootInfo &&
    scopeIdentity.targetDevice === String(info.dev) &&
    scopeIdentity.targetInode === String(info.ino) &&
    scopeIdentity.rootDevice === String(rootInfo.dev) &&
    scopeIdentity.rootInode === String(rootInfo.ino)
      ? { version: 1 as const, ...scopeCandidate, ...scopeIdentity }
      : undefined
  if (candidateBoundRead && !readScope) yield* Effect.promise(() => closeBoundExternalTextFile(candidateBoundRead))
  const boundRead = readScope && candidateBoundRead ? candidateBoundRead : undefined
  const readBinding = boundRead
    ? {
        version: 1 as const,
        contract: "pinned-external-text-v1" as const,
        bindingId: boundRead.bindingId,
      }
    : undefined
  const searchBinding =
    readScope &&
    options?.tool === "grep" &&
    kind === "file" &&
    options.searchBinding?.version === 1 &&
    options.searchBinding.contract === "pinned-external-search-v1" &&
    /^[0-9a-f]{32}$/u.test(options.searchBinding.bindingId) &&
    options.searchBinding.effects.length === 0 &&
    options.searchBinding.mode === "file" &&
    options.searchBinding.executor === "ripgrep-inherited-readonly-fd-v1"
      ? options.searchBinding
      : undefined
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx
    .ask({
      permission: "external_directory",
      patterns: [glob],
      always: [glob],
      metadata: {
        filepath: full,
        parentDir: dir,
        ...(options?.tool ? { tool: options.tool } : {}),
        ...(readScope ? { readScope } : {}),
        ...(readBinding ? { readBinding } : {}),
        ...(searchBinding ? { searchBinding } : {}),
      },
    })
    .pipe(
      Effect.onExit((exit) =>
        boundRead && Exit.isFailure(exit) ? Effect.promise(() => closeBoundExternalTextFile(boundRead)) : Effect.void,
      ),
    )
  return {
    version: 1 as const,
    lexicalTarget: lexical,
    canonicalTarget: resolved,
    canonicalRoot: root,
    kind,
    targetDevice: info?.dev,
    targetInode: info?.ino,
    rootDevice: rootInfo?.dev,
    rootInode: rootInfo?.ino,
    readScope,
    readBinding,
    boundRead,
    searchBinding,
  }
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
