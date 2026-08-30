import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect, verifyExternalDirectoryEffect } from "./external-directory"
import { containsPath } from "../project/instance-context"
import DESCRIPTION from "./grep.txt"
import {
  bindSearchDirectory,
  closeBoundSearchDirectory,
  verifyBoundSearchDirectory,
  type BoundSearchDirectory,
} from "./search-bound-directory"
import {
  bindExternalTextFile,
  closeBoundExternalTextFile,
  readBoundExternalTextFile,
  type BoundExternalTextFile,
} from "./external-read-bound-file"
import {
  bindGrepFiles,
  closeGrepSnapshot,
  LITERAL_GREP_LIMITS,
  literalBranches,
  readBoundGrepFile,
  type BoundGrepSnapshot,
} from "./grep-bound-files"
import * as Tool from "./tool"
import { exactSearchIncludeTarget } from "@/util/exact-search-include"
import { trustedCanonicalAlias } from "@/util/trusted-path-alias"

const RESULT_LIMIT = 100
const EXTERNAL_GREP_FD = 3

type SearchBinding =
  | { readonly kind: "directory"; readonly value: BoundSearchDirectory }
  | { readonly kind: "file"; readonly value: BoundExternalTextFile }

async function searchBoundSnapshot(snapshot: BoundGrepSnapshot, literals: readonly string[]) {
  const rows: { path: string; line: number; text: string }[] = []
  const documents: { target: string; text: string }[] = []
  let totalBytes = 0
  for (const item of snapshot.files) {
    const buffer = await readBoundGrepFile(item)
    totalBytes += buffer.length
    if (totalBytes > LITERAL_GREP_LIMITS.totalBytes) throw new Error("Pinned grep snapshot exceeded the size limit")
    // Match ripgrep's default binary-file behaviour: a NUL marks the file as binary,
    // so it contributes no matching lines. Keep it in the bound snapshot and byte
    // accounting so post-review mutation still fails closed.
    if (buffer.includes(0)) continue
    documents.push({ target: item.target, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer) })
  }
  if (totalBytes !== snapshot.totalBytes) throw new Error("Pinned grep snapshot size changed")

  for (const document of documents) {
    let start = 0
    let lineNumber = 1
    while (start < document.text.length) {
      const newline = document.text.indexOf("\n", start)
      const end = newline === -1 ? document.text.length : newline + 1
      const line = document.text.slice(start, end)
      if (literals.some((literal) => line.includes(literal))) {
        rows.push({
          path: document.target,
          line: lineNumber,
          text: line.length > 2000 ? `${line.slice(0, 2000)}...` : line,
        })
      }
      if (rows.length === RESULT_LIMIT) return rows
      if (newline === -1) break
      start = end
      lineNumber++
    }
  }
  return rows
}

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const input = { ...params }
          const empty = {
            title: input.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!input.pattern) {
            throw new Error("pattern is required")
          }

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(input.path ?? ins.directory)
            ? (input.path ?? ins.directory)
            : path.join(ins.directory, input.path ?? ".")
          const lexical = path.resolve(requested)
          const requestedSearch = FSUtil.resolve(lexical)
          const requestedSearchInfo = yield* fs
            .stat(requestedSearch)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          const aliasTrusted = yield* Effect.promise(() => trustedCanonicalAlias(lexical, requestedSearch))
          const exactIncludeLexical =
            aliasTrusted && requestedSearchInfo?.type === "Directory" && !containsPath(requestedSearch, ins)
              ? exactSearchIncludeTarget(input, ins.directory)
              : undefined
          const exactIncludeTarget = exactIncludeLexical
            ? path.join(requestedSearch, path.basename(exactIncludeLexical))
            : undefined
          const exactIncludeSearch = exactIncludeTarget ? FSUtil.resolve(exactIncludeTarget) : undefined
          const exactIncludeInfo =
            exactIncludeTarget &&
            exactIncludeSearch === exactIncludeTarget &&
            path.dirname(exactIncludeTarget) === requestedSearch
              ? yield* fs.stat(exactIncludeSearch).pipe(Effect.catch(() => Effect.succeed(undefined)))
              : undefined
          const search = exactIncludeInfo?.type === "File" ? exactIncludeSearch! : requestedSearch
          const requestedInfo = exactIncludeInfo?.type === "File" ? exactIncludeInfo : requestedSearchInfo
          const cwd = requestedInfo?.type === "Directory" ? search : path.dirname(search)
          const isExternal = !containsPath(search, ins)
          const reviewCwd =
            isExternal && requestedInfo?.type === "File" ? path.dirname(exactIncludeLexical ?? lexical) : cwd

          const projectDirectoryEligible = !isExternal && requestedInfo?.type === "Directory" && lexical === search
          return yield* Effect.acquireUseRelease(
            Effect.promise(async (): Promise<SearchBinding | undefined> => {
              if (isExternal && aliasTrusted && requestedInfo?.type === "File") {
                const value = await bindExternalTextFile(search)
                return value ? { kind: "file", value } : undefined
              }
              if (isExternal && requestedInfo?.type === "Directory") {
                const value = await bindSearchDirectory(search, search)
                return value ? { kind: "directory", value } : undefined
              }
              if (projectDirectoryEligible) {
                const value = await bindSearchDirectory(ins.directory, search)
                return value ? { kind: "directory", value } : undefined
              }
            }),
            (binding) =>
              Effect.gen(function* () {
                if (!isExternal && requestedInfo?.type === "Directory" && !binding)
                  throw new Error("Project search directory could not be bound safely")
                const externalBinding = isExternal ? binding : undefined
                // A directory descriptor does not confine same-device descendant bind mounts. Retain it only to
                // execute a human-authorised search against the reviewed directory; never attest completeness.
                const searchBinding =
                  externalBinding?.kind === "file"
                    ? {
                        version: 1 as const,
                        contract: "pinned-external-search-v1" as const,
                        mode: "file" as const,
                        executor: "ripgrep-inherited-readonly-fd-v1" as const,
                        bindingId: externalBinding.value.bindingId,
                        effects: [] as const,
                      }
                    : undefined
                const external = yield* assertExternalDirectoryEffect(ctx, search, {
                  bypass: false,
                  kind: requestedInfo?.type === "Directory" ? "directory" : "file",
                  tool: "grep",
                  searchBinding,
                  scopeIdentity:
                    externalBinding?.kind === "file"
                      ? {
                          targetDevice: externalBinding.value.fileGeneration.dev.toString(),
                          targetInode: externalBinding.value.fileGeneration.ino.toString(),
                          rootDevice: externalBinding.value.rootGeneration.dev.toString(),
                          rootInode: externalBinding.value.rootGeneration.ino.toString(),
                        }
                      : undefined,
                })
                const render = (rows: { path: string; line: number; text: string }[]) => {
                  if (rows.length === 0) return empty
                  const truncated = rows.length === RESULT_LIMIT
                  const output = [`Found ${rows.length} matches${truncated ? " (more matches available)" : ""}`]
                  let current = ""
                  for (const match of rows) {
                    const logical = requestedInfo?.type === "File" ? search : path.resolve(requested, match.path)
                    if (current !== logical) {
                      if (current !== "") output.push("")
                      current = logical
                      output.push(`${logical}:`)
                    }
                    output.push(`  Line ${match.line}: ${match.text}`)
                  }
                  if (truncated) {
                    output.push("")
                    output.push("(Results truncated. Consider using a more specific path or pattern.)")
                  }
                  return {
                    title: input.pattern,
                    metadata: { matches: rows.length, truncated },
                    output: output.join("\n"),
                  }
                }

                const ask = (complete: boolean, arguments_: unknown = input) =>
                  ctx.ask({
                    permission: "grep",
                    patterns: [input.pattern],
                    always: ["*"],
                    metadata: {
                      pattern: input.pattern,
                      ...(input.path === undefined ? {} : { path: input.path }),
                      ...(input.include === undefined ? {} : { include: input.include }),
                    },
                    action: { identity: "grep", arguments: arguments_, cwd: reviewCwd, complete },
                  })

                const legacy = Effect.gen(function* () {
                  const boundArguments =
                    externalBinding?.kind === "file"
                      ? {
                          contract: "pinned-external-search-v1",
                          mode: "bound",
                          kind: "file",
                          executor: searchBinding!.executor,
                          bindingId: externalBinding.value.bindingId,
                          invocation: input,
                          effects: [],
                        }
                      : !isExternal && binding?.kind === "directory"
                        ? {
                            contract: "pinned-project-search-v1",
                            mode: "directory",
                            tool: "grep",
                            executor: "ripgrep-procfd-cwd-v1",
                            bindingId: binding.value.bindingId,
                            invocation: input,
                            effects: [],
                          }
                        : undefined
                  yield* ask(Boolean(boundArguments), boundArguments ?? input)
                  yield* verifyExternalDirectoryEffect(external)
                  if (externalBinding?.kind === "directory") {
                    yield* Effect.promise(() => verifyBoundSearchDirectory(externalBinding.value))
                  }
                  if (externalBinding?.kind === "file") {
                    yield* Effect.promise(() => readBoundExternalTextFile(externalBinding.value)).pipe(Effect.asVoid)
                  }
                  const result = yield* ripgrep.grep({
                    cwd:
                      binding?.kind === "directory"
                        ? binding.value.cwd
                        : binding?.kind === "file"
                          ? `/proc/self/fd/${binding.value.root.fd}`
                          : cwd,
                    file:
                      binding?.kind === "file"
                        ? `/proc/self/fd/${EXTERNAL_GREP_FD}`
                        : requestedInfo?.type === "File"
                          ? path.basename(search)
                          : undefined,
                    pattern: input.pattern,
                    include: binding?.kind === "file" ? undefined : input.include,
                    limit: RESULT_LIMIT,
                    inheritedReadOnlyFds:
                      binding?.kind === "file"
                        ? [{ parent: binding.value.file.fd, child: EXTERNAL_GREP_FD }]
                        : undefined,
                  })
                  if (externalBinding?.kind === "directory") {
                    yield* Effect.promise(() => verifyBoundSearchDirectory(externalBinding.value))
                  }
                  if (externalBinding?.kind === "file") {
                    yield* Effect.promise(() => readBoundExternalTextFile(externalBinding.value)).pipe(Effect.asVoid)
                  }
                  return render(result.map((item) => ({ path: item.entry.path, line: item.line, text: item.text })))
                })

                const literals = literalBranches(input.pattern)
                const bound = binding?.kind === "directory" ? binding.value : undefined
                if (isExternal || search !== ins.directory || !bound || !literals || input.include !== undefined)
                  return yield* legacy
                const entries = yield* ripgrep
                  .find({
                    cwd: bound.cwd,
                    pattern: "*",
                    limit: LITERAL_GREP_LIMITS.files,
                    hidden: true,
                    oneFileSystem: true,
                    nullSeparated: true,
                    preservePath: true,
                    strict: true,
                  })
                  .pipe(
                    Effect.map((items) => items.map((item) => String(item.path))),
                    Effect.catch(() => Effect.succeed(undefined)),
                  )
                if (!entries) return yield* legacy
                return yield* Effect.acquireUseRelease(
                  Effect.promise(() => bindGrepFiles(bound, entries)),
                  (snapshot) =>
                    snapshot
                      ? Effect.gen(function* () {
                          yield* ask(true, {
                            pattern: input.pattern,
                            path: input.path ?? null,
                            literals,
                            mode: "pinned-project-literal-grep-v4",
                            executor: "literal-utf8-lf-lines-v1",
                            bindingId: snapshot.bindingId,
                            fileCount: snapshot.files.length,
                            totalBytes: snapshot.totalBytes,
                            limits: LITERAL_GREP_LIMITS,
                            effects: [],
                          })
                          const rows = yield* Effect.promise(() => searchBoundSnapshot(snapshot, literals))
                          return render(rows)
                        })
                      : legacy,
                  (snapshot) => (snapshot ? Effect.promise(() => closeGrepSnapshot(snapshot)) : Effect.void),
                )
              }),
            (binding) =>
              binding?.kind === "directory"
                ? Effect.promise(() => closeBoundSearchDirectory(binding.value))
                : binding?.kind === "file"
                  ? Effect.promise(() => closeBoundExternalTextFile(binding.value))
                  : Effect.void,
          )
        }).pipe(Effect.orDie),
    }
  }),
)
