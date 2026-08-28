import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect, verifyExternalDirectoryEffect } from "./external-directory"
import { containsPath } from "../project/instance-context"
import DESCRIPTION from "./glob.txt"
import { bindSearchDirectory, closeBoundSearchDirectory, verifyBoundSearchDirectory } from "./search-bound-directory"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const input = { ...params }
          const ins = yield* InstanceState.context
          const requested = input.path ?? ins.directory
          const lexical = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(ins.directory, requested)
          const search = FSUtil.resolve(lexical)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }

          const isExternal = !containsPath(search, ins)
          const projectEligible = !isExternal && info?.type === "Directory" && lexical === search
          return yield* Effect.acquireUseRelease(
            isExternal
              ? Effect.promise(() => bindSearchDirectory(search, search))
              : projectEligible
                ? Effect.promise(() => bindSearchDirectory(ins.directory, search))
                : Effect.succeed(undefined),
            (bound) =>
              Effect.gen(function* () {
                if (!isExternal && !bound) throw new Error("Project search directory could not be bound safely")
                const external = yield* assertExternalDirectoryEffect(ctx, search, {
                  bypass: false,
                  kind: "directory",
                  tool: "glob",
                })
                const boundArguments =
                  !isExternal && bound
                    ? {
                        contract: "pinned-project-search-v1",
                        mode: "directory",
                        tool: "glob",
                        executor: "ripgrep-procfd-cwd-v1",
                        bindingId: bound.bindingId,
                        invocation: input,
                        effects: [],
                      }
                    : undefined
                yield* ctx.ask({
                  permission: "glob",
                  patterns: [input.pattern],
                  always: ["*"],
                  metadata: {
                    pattern: input.pattern,
                    ...(input.path === undefined ? {} : { path: input.path }),
                  },
                  action: {
                    identity: "glob",
                    arguments: boundArguments ?? input,
                    cwd: search,
                    // External traversal remains human-authorised: a root descriptor and ripgrep's device-based
                    // one-file-system boundary do not confine same-device descendant bind mounts.
                    complete: Boolean(boundArguments),
                  },
                })

                yield* verifyExternalDirectoryEffect(external)
                if (bound) yield* Effect.promise(() => verifyBoundSearchDirectory(bound))
                const limit = 100
                const files = yield* ripgrep.glob({
                  cwd: bound?.cwd ?? search,
                  pattern: input.pattern,
                  limit,
                  oneFileSystem: Boolean(bound),
                })
                if (bound) yield* Effect.promise(() => verifyBoundSearchDirectory(bound))
                const truncated = files.length === limit

                const output = []
                if (files.length === 0) output.push("No files found")
                if (files.length > 0) {
                  output.push(...files.map((file) => path.resolve(search, file.path)))
                  if (truncated) {
                    output.push("")
                    output.push(
                      `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
                    )
                  }
                }

                return {
                  title: path.relative(ins.worktree, search),
                  metadata: {
                    count: files.length,
                    truncated,
                  },
                  output: output.join("\n"),
                }
              }),
            (bound) => (bound ? Effect.promise(() => closeBoundSearchDirectory(bound)) : Effect.void),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
