export * as Ripgrep from "./ripgrep.js"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { Entry, Match } from "@opencode/schema/filesystem"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { collectStream, waitForAbort } from "@opencode/util/process"
import { registerInheritedReadOnlyFds, type InheritedReadOnlyFd } from "@opencode/util/cross-spawn-spawner"
import { TextBoundary } from "@opencode/util/text-boundary"
import type { Environment } from "./environment/index.js"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"
import { RipgrepBinary } from "./ripgrep/binary.js"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_SUBMATCHES = 100
const MAX_LINE_CHARS = 2_000

// rg reports data that is not valid UTF-8 as base64 `bytes` instead of `text`.
const RawData = Schema.Union([Schema.Struct({ text: Schema.String }), Schema.Struct({ bytes: Schema.String })])

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: RawData,
    lines: RawData,
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: RawData,
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const rawText = (data: typeof RawData.Type) =>
  "text" in data ? data.text : Buffer.from(data.bytes, "base64").toString("utf8")

export class Error extends Schema.TaggedError<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidGlobError extends Error {}

export class InvalidPatternError extends Schema.TaggedError<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly environment: Environment.Interface
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly exclude?: readonly string[]
  readonly hidden?: boolean
  readonly follow?: boolean
  /** Do not descend into other mounted filesystems. */
  readonly oneFileSystem?: boolean
  /** Fail instead of returning a truncated or partially decoded enumeration. */
  readonly strict?: boolean
  /** Keep the exact path bytes ripgrep printed rather than normalising separators. */
  readonly preservePath?: boolean
  /** Separate records with NUL so file names containing newlines survive. */
  readonly nullSeparated?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly environment: Environment.Interface
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  /** Do not descend into other filesystems; used with a descriptor-bound search directory. */
  readonly oneFileSystem?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly environment: Environment.Interface
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly literal?: boolean
  readonly caseSensitive?: boolean
  readonly limit: number
  /** Do not descend into other filesystems; used with a descriptor-bound search directory. */
  readonly oneFileSystem?: boolean
  readonly signal?: AbortSignal
  /** Search an already-open descriptor (as `/proc/self/fd/N`) instead of reopening a pathname. */
  readonly inheritedReadOnlyFds?: ReadonlyArray<InheritedReadOnlyFd>
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const normalizePath = (value: string) =>
  value
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/")

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly environment: Environment.Interface
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
      readonly nullSeparated?: boolean
      readonly strict?: boolean
      readonly inheritedReadOnlyFds?: ReadonlyArray<InheritedReadOnlyFd>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          // Hosted environments will resolve rg through their driver image; the spawner is the execution seam.
          const command = ChildProcess.make(yield* binary.filepath, input.args, {
            cwd: input.cwd,
            extendEnv: true,
            stdin: "ignore",
          })
          if (input.inheritedReadOnlyFds) registerInheritedReadOnlyFds(command, input.inheritedReadOnlyFds)
          const handle = yield* input.environment.spawner.spawn(command)
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          let unterminated = false
          const records = input.nullSeparated
            ? Stream.decodeText(handle.stdout).pipe(
                Stream.mapAccumArray(
                  () => "",
                  (remainder, chunk) => {
                    const records = `${remainder}${chunk.join("")}`.split("\0")
                    return [records.pop() ?? "", records]
                  },
                  {
                    onHalt: (remainder) => {
                      unterminated = remainder.length > 0
                      return []
                    },
                  },
                ),
              )
            : Stream.decodeText(handle.stdout).pipe(Stream.splitLines)
          const rows = yield* records.pipe(
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
          )
          const truncated = rows.length > input.limit
          if (truncated) {
            if (input.strict) return yield* failure("ripgrep enumeration was truncated")
            return rows.slice(0, input.limit)
          }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (code === 2) {
            // rg 13 omits the program name. Ignore-file diagnostics start with a path and line number.
            const prefix = /^(?:rg: )?error parsing glob /.exec(stderr)
            if (prefix) return yield* new InvalidGlobError({ message: stderr.slice(prefix[0].length).trimEnd() })
          }
          if (unterminated) return yield* failure("ripgrep emitted an incomplete record")
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return code === 1 ? [] : rows
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    return Service.of({
      glob: (input) =>
        run<string>({
          environment: input.environment,
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.oneFileSystem ? ["--one-file-system"] : []),
            `--glob=${input.pattern}`,
            // Positive globs override rg's hidden-file filter; exclude before applying the result limit.
            ...(input.hidden ? [] : ["--glob=!**/.*"]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => Effect.succeed(normalizePath(line)),
        }).pipe(
          Effect.map((result) =>
            result.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          environment: input.environment,
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          nullSeparated: input.nullSeparated,
          strict: input.strict,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.oneFileSystem ? ["--one-file-system"] : []),
            ...(input.nullSeparated ? ["--null"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            ...(input.exclude ?? []).map((pattern) => `--glob=!${pattern}`),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = input.preservePath
              ? line.replace(/^(?:\.[\\/])+/u, "").replace(/^[\\/]+/u, "")
              : normalizePath(line)
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause)))),
      grep: (input) =>
        run({
          ...input,
          inheritedReadOnlyFds: input.inheritedReadOnlyFds,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.literal ? ["--fixed-strings"] : []),
            ...(input.caseSensitive === false ? ["--ignore-case"] : []),
            ...(input.oneFileSystem ? ["--one-file-system"] : []),
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            decodeJsonRecord(line).pipe(
              Effect.mapError((cause) => failure("Invalid ripgrep JSON output", cause)),
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.undefined
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => {
                    const lines = rawText(match.data.lines)
                    return {
                      ...match.data,
                      lines: {
                        text:
                          lines.length > MAX_LINE_CHARS
                            ? TextBoundary.head(lines, MAX_LINE_CHARS) + "..."
                            : lines,
                      },
                      path: { text: normalizePath(rawText(match.data.path)) },
                      submatches: match.data.submatches.slice(0, MAX_SUBMATCHES).map((submatch) => ({
                        ...submatch,
                        match: { text: rawText(submatch.match) },
                      })),
                    }
                  }),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.map((match) =>
              Match.make({
                entry: Entry.make({
                  path: RelativePath.make(match.path.text),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text: match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              }),
            ),
          ),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [RipgrepBinary.node] })
