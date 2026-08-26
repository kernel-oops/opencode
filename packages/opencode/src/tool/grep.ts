import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import { bindSearchDirectory } from "./search-bound-directory"
import {
  bindGrepFiles,
  closeGrepSnapshot,
  LITERAL_GREP_LIMITS,
  literalBranches,
  readBoundGrepFile,
  type BoundGrepSnapshot,
} from "./grep-bound-files"
import * as Tool from "./tool"

const RESULT_LIMIT = 100

async function searchBoundSnapshot(snapshot: BoundGrepSnapshot, literals: readonly string[]) {
  const rows: { path: string; line: number; text: string }[] = []
  const documents: { target: string; text: string }[] = []
  let totalBytes = 0
  for (const item of snapshot.files) {
    const buffer = await readBoundGrepFile(item)
    totalBytes += buffer.length
    if (totalBytes > LITERAL_GREP_LIMITS.totalBytes) throw new Error("Pinned grep snapshot exceeded the size limit")
    if (buffer.includes(0)) throw new Error("Pinned grep corpus contains a binary file")
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
          const search = FSUtil.resolve(lexical)
          const requestedInfo = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })
          const cwd = requestedInfo?.type === "Directory" ? search : path.dirname(search)

          const eligible =
            requestedInfo?.type === "Directory" &&
            cwd === ins.directory &&
            (input.path === undefined || lexical === search)
          return yield* Effect.acquireUseRelease(
            eligible ? Effect.promise(() => bindSearchDirectory(ins.directory, cwd)) : Effect.succeed(undefined),
            (bound) =>
              Effect.gen(function* () {
                const render = (rows: { path: string; line: number; text: string }[]) => {
                  if (rows.length === 0) return empty
                  const truncated = rows.length === RESULT_LIMIT
                  const output = [`Found ${rows.length} matches${truncated ? " (more matches available)" : ""}`]
                  let current = ""
                  for (const match of rows) {
                    const logical = path.resolve(
                      requestedInfo?.type === "Directory" ? requested : path.dirname(requested),
                      match.path,
                    )
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
                    action: { identity: "grep", arguments: arguments_, cwd, complete },
                  })

                const legacy = Effect.gen(function* () {
                  yield* ask(false)
                  const result = yield* ripgrep.grep({
                    cwd: bound?.cwd ?? cwd,
                    pattern: input.pattern,
                    include: input.include,
                    limit: RESULT_LIMIT,
                  })
                  return render(result.map((item) => ({ path: item.entry.path, line: item.line, text: item.text })))
                })

                const literals = literalBranches(input.pattern)
                if (!bound || !literals || input.include !== undefined) return yield* legacy
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
            (bound) => (bound ? Effect.promise(() => bound.directory.close().catch(() => {})) : Effect.void),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
