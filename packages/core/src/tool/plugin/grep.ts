export * as GrepTool from "./grep.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import { realpath, stat } from "node:fs/promises"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { Ripgrep } from "../../ripgrep.js"
import { RelativePath } from "../../schema.js"
import { BoundExternal } from "../bound/external.js"
import { BoundExternalFile } from "@opencode/util/bound/external-file"
import { BoundSearchDirectory } from "@opencode/util/bound/search-directory"
import { ReviewAction } from "@opencode/util/bound/review-action"
import { ExactSearchInclude } from "@opencode/util/bound/exact-search-include"
import { TrustedPathAlias } from "@opencode/util/bound/trusted-path-alias"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern
    .check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
    .annotate({
      description: "Regular expression or literal text to match in file contents.",
    }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "File or directory to search. Defaults to the current working directory.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
  }),
  literal: FileSystem.GrepInput.fields.literal.annotate({
    description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
  }),
  caseSensitive: FileSystem.GrepInput.fields.caseSensitive.annotate({
    description: "Use case-sensitive matching (default: true).",
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum number of matching lines to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type EncodedOutput = typeof Output.Encoded

/** Format raw search matches into concise model content. */
export const toModelContent = (matches: EncodedOutput, truncated = false) => {
  const lines = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`]
  let current = ""
  for (const match of matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`,
    )
  return lines.join("\n")
}

const pinnedFailure = (error: unknown) =>
  new ToolFailure({ message: error instanceof Error ? error.message : "Pinned search target changed", error })

type Bindings = {
  readonly file?: BoundExternalFile.Bound
  readonly directory?: BoundSearchDirectory.Bound
  readonly scope?: BoundExternal.Scope
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "opencode.tool.grep",
  effect: Effect.fn("GrepTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    // Descriptor pinning walks the host filesystem directly, so it only applies to the local environment.
    const bindable = location.workspaceID === undefined && process.platform === "linux"

    const missingPath = (requested: string | undefined) =>
      Effect.fail(new ToolFailure({ message: `Search path does not exist: ${requested ?? "."}` }))

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              const initial = yield* access.resolve({ path: input.path ?? "." })

              // A root-owned ancestor alias (a home directory mounted elsewhere) is reviewed by its canonical name.
              const canonical = yield* Effect.promise(() => realpath(initial.absolute).catch(() => undefined))
              const aliased =
                bindable &&
                initial.externalDirectory !== undefined &&
                canonical !== undefined &&
                canonical !== initial.absolute &&
                (yield* Effect.promise(() => TrustedPathAlias.trusted(initial.absolute, canonical)))
              const requested = aliased ? yield* access.resolve({ path: canonical }) : initial
              // Unlike upstream (which asks first, then stats), this type-check must precede the ask: it decides
              // whether `include` names an exact single file inside `requested` (below), which determines what
              // gets bound and, in turn, what the ask's resource/metadata actually describe. There is no way to
              // ask a well-formed question first and discover the answer's shape afterwards here, so an unapproved
              // request does learn whether `requested` exists and its type — a narrower, intentional trade-off for
              // the exact-file-search feature, not an accidental reorder.
              const requestedType = yield* Environment.typeFollowing(environment.files, requested.absolute).pipe(
                Effect.catchTag("Environment.NotFound", () => missingPath(input.path)),
              )

              // An `include` naming one plain file inside an external directory is an exact file search.
              const exact =
                bindable &&
                requested.externalDirectory !== undefined &&
                requestedType === "directory" &&
                (aliased || canonical === initial.absolute)
                  ? ExactSearchInclude.target({ path: requested.absolute, include: input.include }, location.directory)
                  : undefined
              const exactFile = exact ? path.join(requested.absolute, path.basename(exact)) : undefined
              const exactInfo = exactFile
                ? yield* Effect.promise(() =>
                    realpath(exactFile)
                      .then((real) => (real === exactFile ? stat(exactFile) : undefined))
                      .catch(() => undefined),
                  )
                : undefined
              const target =
                exactFile && exactInfo?.isFile() ? yield* access.resolve({ path: exactFile, kind: "file" }) : requested
              const kind: BoundExternal.Kind =
                target === requested ? (requestedType === "directory" ? "directory" : "file") : "file"
              const external = target.externalDirectory !== undefined
              const root = target.absolute
              const cwd = kind === "directory" ? root : path.dirname(root)

              const bind = Effect.promise(async (): Promise<Bindings> => {
                if (!bindable) return {}
                const file = external && kind === "file" ? await BoundExternalFile.bind(root) : undefined
                const directory =
                  kind === "directory"
                    ? await BoundSearchDirectory.bind(external ? root : location.directory, root)
                    : undefined
                const searchBinding: BoundExternal.SearchBinding | undefined = file
                  ? {
                      version: 1,
                      contract: "pinned-external-search-v1",
                      mode: "file",
                      executor: "ripgrep-bound-description-v1",
                      bindingId: file.bindingId,
                      effects: [],
                    }
                  : undefined
                const scope = external
                  ? await BoundExternal.inspect(target, {
                      kind,
                      tool: name,
                      searchBinding,
                      scopeIdentity: file
                        ? {
                            targetDevice: file.fileGeneration.dev.toString(),
                            targetInode: file.fileGeneration.ino.toString(),
                            rootDevice: file.rootGeneration.dev.toString(),
                            rootInode: file.rootGeneration.ino.toString(),
                          }
                        : undefined,
                    })
                  : undefined
                return { file, directory, scope }
              })

              return yield* Effect.acquireUseRelease(
                bind,
                (bindings) =>
                  Effect.gen(function* () {
                    const fileBinding = bindings.scope?.searchBinding ? bindings.file : undefined
                    const directoryBinding = bindings.directory
                    yield* access.authorizeExternal([target], context, BoundExternal.metadata(bindings.scope))
                    const boundArguments = fileBinding
                      ? {
                          contract: "pinned-external-search-v1",
                          mode: "bound",
                          kind: "file",
                          executor: "ripgrep-bound-description-v1",
                          bindingId: fileBinding.bindingId,
                          invocation: input,
                          effects: [],
                        }
                      : directoryBinding && !external
                        ? {
                            contract: "pinned-project-search-v1",
                            mode: "directory",
                            tool: name,
                            executor: "ripgrep-procfd-cwd-v1",
                            bindingId: directoryBinding.bindingId,
                            invocation: input,
                            effects: [],
                          }
                        : undefined
                    yield* permission.assert({
                      action: name,
                      resources: [input.pattern],
                      save: ["*"],
                      metadata: {
                        root: ".",
                        path: input.path,
                        include: input.include,
                        literal: input.literal,
                        caseSensitive: input.caseSensitive,
                        limit: input.limit,
                        // An external directory descriptor does not confine same-device descendant bind mounts, so
                        // only file and project bindings are attested as complete.
                        [ReviewAction.KEY]: ReviewAction.make({
                          identity: name,
                          arguments: boundArguments ?? input,
                          cwd,
                          complete: Boolean(boundArguments),
                        }),
                      },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                    const verifyBindings = Effect.gen(function* () {
                      yield* BoundExternal.verify(bindings.scope).pipe(Effect.mapError(pinnedFailure))
                      if (directoryBinding)
                        yield* Effect.tryPromise({
                          try: () => BoundSearchDirectory.verify(directoryBinding),
                          catch: pinnedFailure,
                        })
                      if (fileBinding)
                        yield* Effect.tryPromise({
                          try: () => BoundExternalFile.verify(fileBinding),
                          catch: pinnedFailure,
                        })
                    })
                    yield* verifyBindings
                    const limit = input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT
                    const matches = yield* ripgrep
                      .grep({
                        cwd: directoryBinding ? directoryBinding.cwd : cwd,
                        pattern: input.pattern,
                        file: fileBinding
                          ? BoundExternalFile.processPath(fileBinding)
                          : kind === "file"
                            ? path.basename(root)
                            : undefined,
                        include: fileBinding || target !== requested ? undefined : input.include,
                        literal: input.literal,
                        caseSensitive: input.caseSensitive,
                        limit: limit + 1,
                        oneFileSystem: Boolean(directoryBinding),
                      })
                      .pipe(
                        Effect.timeoutOrElse({
                          duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
                          orElse: () =>
                            Effect.fail(
                              new ToolFailure({
                                message: `Search timed out after ${FileSystem.DEFAULT_SEARCH_TIMEOUT_MS / 1_000} seconds. Consider using a more specific path or pattern.`,
                              }),
                            ),
                        }),
                        Effect.map((result) =>
                          result.map((match) =>
                            FileSystem.Match.make({
                              ...match,
                              entry: FileSystem.Entry.make({
                                ...match.entry,
                                path: RelativePath.make(
                                  path.relative(
                                    location.directory,
                                    fileBinding ? root : path.resolve(cwd, match.entry.path),
                                  ),
                                ),
                              }),
                            }),
                          ),
                        ),
                      )
                    yield* verifyBindings
                    return { matches: matches.slice(0, limit), truncated: matches.length > limit }
                  }),
                (bindings) =>
                  Effect.promise(async () => {
                    if (bindings.directory) await BoundSearchDirectory.close(bindings.directory)
                    if (bindings.file) await BoundExternalFile.close(bindings.file)
                    await BoundExternal.release(bindings.scope)
                  }),
              )
            }).pipe(
              Effect.map((result) => ({
                output: result.matches,
                content: toModelContent(
                  result.matches.map((match) => ({
                    ...match,
                    entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                  })),
                  result.truncated,
                ),
                metadata: { matches: result.matches.length, truncated: result.truncated },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof Ripgrep.InvalidPatternError
                    ? new ToolFailure({ message: `Invalid regex pattern: ${error.message}` })
                    : new ToolFailure({ message: `Unable to grep for ${input.pattern}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
