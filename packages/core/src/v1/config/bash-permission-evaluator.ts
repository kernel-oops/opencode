export * as ConfigBashPermissionEvaluatorV1 from "./bash-permission-evaluator"

import { Effect, Schema, SchemaGetter } from "effect"
import path from "node:path"
import { PositiveInt } from "../../schema"

const AbsolutePath = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => path.isAbsolute(value) || "must be an absolute path"),
)
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const TimeoutSeconds = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(30))
const InputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(256 * 1024))
const OutputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(4 * 1024))

const ExpectedOutput = Schema.Struct({
  implementation: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
  protocol: Schema.NonEmptyString,
  platform: Schema.NonEmptyString,
})
const ExpectedInput = Schema.StructWithRest(ExpectedOutput, [Schema.Record(Schema.String, Schema.Unknown)]).check(
  Schema.makeFilter((value) => Object.keys(value).length === 5 || "expected identity contains unknown fields"),
)
const Expected = ExpectedInput.pipe(
  Schema.decodeTo(ExpectedOutput, {
    decode: SchemaGetter.passthrough({ strict: false }),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

const Active = {
  executable: AbsolutePath,
  policy: AbsolutePath,
  executable_sha256: Sha256,
  policy_sha256: Sha256,
  expected: Expected,
  timeout_seconds: TimeoutSeconds.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
  capacity: PositiveInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(4))),
  max_input_bytes: InputBytes.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(256 * 1024))),
  max_output_bytes: OutputBytes.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(4 * 1024))),
}

const DisabledOutput = Schema.Struct({ mode: Schema.Literal("disabled") })
const DisabledInput = Schema.StructWithRest(DisabledOutput, [Schema.Record(Schema.String, Schema.Unknown)]).check(
  Schema.makeFilter((value) => Object.keys(value).length === 1 || "disabled mode cannot include evaluator fields"),
)
const Disabled = DisabledInput.pipe(
  Schema.decodeTo(DisabledOutput, {
    decode: SchemaGetter.transform(({ mode }) => ({ mode })),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

const ActiveKeys = new Set([
  "mode",
  "executable",
  "policy",
  "executable_sha256",
  "policy_sha256",
  "expected",
  "timeout_seconds",
  "capacity",
  "max_input_bytes",
  "max_output_bytes",
])
const active = (mode: "audit-only" | "permit-only" | "enforce") => {
  const output = Schema.Struct({ mode: Schema.Literal(mode), ...Active })
  const input = Schema.StructWithRest(output, [Schema.Record(Schema.String, Schema.Unknown)]).check(
    Schema.makeFilter(
      (value) => Object.keys(value).every((key) => ActiveKeys.has(key)) || "evaluator contains unknown fields",
    ),
  )
  return input.pipe(
    Schema.decodeTo(output, {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  )
}

export const Info = Schema.Union([Disabled, active("audit-only"), active("permit-only"), active("enforce")]).annotate({
  identifier: "BashPermissionEvaluatorConfig",
})

export type Info = Schema.Schema.Type<typeof Info>
export type Active = Exclude<Info, { mode: "disabled" }>

type GeneratedSchema = Record<string, unknown>

function generatedObject(value: unknown): value is GeneratedSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Effect's excess-property parser is configured globally to ignore unknown keys,
// so runtime strictness needs the explicit filters above. Its JSON generator cannot
// represent those filters; close only the validated evaluator shape during generation.
export function closeGeneratedSchema(value: unknown) {
  if (!generatedObject(value) || !Array.isArray(value.anyOf) || value.anyOf.length !== 4) {
    throw new Error("generated Bash evaluator schema has an unexpected union")
  }

  const modes = new Set<string>()
  for (const item of value.anyOf) {
    if (!generatedObject(item) || !generatedObject(item.properties)) {
      throw new Error("generated Bash evaluator schema has an unexpected branch")
    }
    const mode = item.properties.mode
    if (
      !generatedObject(mode) ||
      !Array.isArray(mode.enum) ||
      mode.enum.length !== 1 ||
      typeof mode.enum[0] !== "string"
    ) {
      throw new Error("generated Bash evaluator schema has an unexpected mode")
    }
    modes.add(mode.enum[0])
    item.additionalProperties = false

    if (mode.enum[0] === "disabled") continue
    const expected = item.properties.expected
    if (!generatedObject(expected)) throw new Error("generated Bash evaluator schema is missing expected identity")
    expected.additionalProperties = false
  }

  if (
    !modes.has("disabled") ||
    !modes.has("audit-only") ||
    !modes.has("permit-only") ||
    !modes.has("enforce") ||
    modes.size !== 4
  ) {
    throw new Error("generated Bash evaluator schema has unexpected modes")
  }
}
