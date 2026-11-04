export * as GlobTool from "./glob.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Ripgrep } from "../../ripgrep.js"
import { RelativePath } from "../../schema.js"
import { Permission } from "../../permission.js"
import { BoundExternal } from "../bound/external.js"
import { BoundSearchDirectory } from "@opencode/util/bound/search-directory"
import { ReviewAction } from "@opencode/util/bound/review-action"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "Directory to search. Defaults to the current working directory.",
  }),
  hidden: FileSystem.GlobInput.fields.hidden.annotate({
    description: "Include hidden files and directories (default: false).",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: `Maximum number of matching files to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

export const Output = Schema.Array(FileSystem.Entry)
type EncodedOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelContent = (entries: EncodedOutput, truncated = false) => {
  const lines = entries.length === 0 ? ["No files found"] : entries.map((item) => item.path)
  if (truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${entries.length} results. Consider using a more specific path or pattern.)`,
    )
  return lines.join("\n")
}

const pinnedFailure = (error: unknown) =>
  new ToolFailure({ message: error instanceof Error ? error.message : "Pinned search directory changed", error })

/** Glob leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "opencode.tool.glob",
  effect: Effect.fn("GlobTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    // Descriptor pinning walks the host filesystem directly, so it only applies to the local environment.
    const bindable = location.workspaceID === undefined && process.platform === "linux"

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const searchPath = input.path === "undefined" || input.path === "null" ? undefined : input.path
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              const target = yield* access.resolve({ path: searchPath ?? ".", kind: "directory" })
              const root = target.absolute
              const external = target.externalDirectory !== undefined
              // Pin the directory behind a descriptor chain: project searches from the Location root, external
              // searches from the external directory itself. Both reject symlinked components and mount crossings.
              // This filesystem access unavoidably precedes the ask below: `bind` must already hold the pinned
              // descriptor's identity before it can be attested in the ask's metadata (`boundArguments`/`complete`).
              // It degrades to no binding (never throws) when the target is missing or not a directory, so it does
              // not itself reveal more than upstream's own resolve step; the existence/type check upstream performs
              // is deliberately kept below, after the ask, so an unapproved request still learns nothing beyond
              // what `bind`'s silent degradation already exposes.
              const binding = bindable
                ? yield* Effect.promise(() => BoundSearchDirectory.bind(external ? root : location.directory, root))
                : undefined
              const scope =
                bindable && external
                  ? yield* Effect.promise(() => BoundExternal.inspect(target, { kind: "directory", tool: name }))
                  : undefined
              return yield* Effect.acquireUseRelease(
                Effect.succeed({ binding, scope }),
                ({ binding, scope }) =>
                  Effect.gen(function* () {
                    yield* access.authorizeExternal([target], context, BoundExternal.metadata(scope))
                    const boundArguments =
                      binding && !external
                        ? {
                            contract: "pinned-project-search-v1",
                            mode: "directory",
                            tool: name,
                            executor: "ripgrep-procfd-cwd-v1",
                            bindingId: binding.bindingId,
                            invocation: input,
                            effects: [],
                          }
                        : undefined
                    yield* permission.assert({
                      action: name,
                      resources: [input.pattern],
                      save: ["*"],
                      metadata: {
                        root: searchPath ?? ".",
                        path: searchPath,
                        hidden: input.hidden,
                        limit: input.limit,
                        // The descriptor proves confinement only for a project search. An external traversal can
                        // still receive exact-invocation review without claiming same-device mount confinement.
                        [ReviewAction.KEY]: ReviewAction.make({
                          identity: name,
                          arguments: boundArguments ?? input,
                          cwd: root,
                          complete: Boolean(boundArguments),
                        }),
                      },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                    yield* BoundExternal.verify(scope).pipe(Effect.mapError(pinnedFailure))
                    if (binding)
                      yield* Effect.tryPromise({
                        try: () => BoundSearchDirectory.verify(binding),
                        catch: pinnedFailure,
                      })
                    // Matches upstream: the existence/type check runs after the ask, not before, so an
                    // unapproved request cannot learn whether an external path exists or what kind it is.
                    const type = yield* Environment.typeFollowing(environment.files, root).pipe(
                      Effect.catchTag("Environment.NotFound", () =>
                        Effect.fail(new ToolFailure({ message: `Search path does not exist: ${searchPath ?? "."}` })),
                      ),
                    )
                    if (type !== "directory")
                      return yield* Effect.fail(
                        new ToolFailure({ message: `Search path is not a directory: ${searchPath ?? "."}` }),
                      )
                    const limit = input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT
                    const entries = yield* ripgrep
                      .glob({
                        cwd: binding?.cwd ?? root,
                        pattern: input.pattern,
                        hidden: input.hidden,
                        limit: limit + 1,
                        oneFileSystem: Boolean(binding),
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
                          result.map((entry) =>
                            FileSystem.Entry.make({
                              ...entry,
                              path: RelativePath.make(
                                path.relative(location.directory, path.resolve(root, entry.path)),
                              ),
                            }),
                          ),
                        ),
                      )
                    if (binding)
                      yield* Effect.tryPromise({
                        try: () => BoundSearchDirectory.verify(binding),
                        catch: pinnedFailure,
                      })
                    return { entries: entries.slice(0, limit), truncated: entries.length > limit }
                  }),
                ({ binding, scope }) =>
                  Effect.promise(async () => {
                    if (binding) await BoundSearchDirectory.close(binding)
                    await BoundExternal.release(scope)
                  }),
              )
            }).pipe(
              Effect.map((result) => ({
                output: result.entries,
                content: toModelContent(
                  result.entries.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
                  result.truncated,
                ),
                metadata: { count: result.entries.length, truncated: result.truncated },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to find files matching ${input.pattern}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
