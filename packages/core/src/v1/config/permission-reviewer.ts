export * as ConfigPermissionReviewerV1 from "./permission-reviewer"

import { Effect, Schema } from "effect"

export const Info = Schema.Struct({
  mode: Schema.Literals(["audit-only", "enforce"]),
  model: Schema.NonEmptyString,
  policy: Schema.Literals(["conservative-v1", "obvious-risk-only-v1"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("conservative-v1" as const)))
    .annotate({ description: 'Fixed reviewer policy. Defaults to "conservative-v1".' }),
  automatic_allow: Schema.Literals(["never", "policy-gated"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("never" as const)))
    .annotate({ description: 'Local automatic-allow policy. Defaults to "never".' }),
  automatic_rewrite: Schema.Literals(["never", "once-per-turn"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("never" as const)))
    .annotate({ description: 'Local automatic-rewrite policy. Defaults to "never".' }),
})
  .check(
    Schema.makeFilter((config) => {
      const automatic = config.automatic_allow === "policy-gated" || config.automatic_rewrite === "once-per-turn"
      return !automatic || (config.mode === "enforce" && config.policy === "obvious-risk-only-v1")
        ? undefined
        : "automatic permission review requires enforce mode and obvious-risk-only-v1"
    }),
  )
  .annotate({ identifier: "PermissionReviewerConfig" })

export type Info = Schema.Schema.Type<typeof Info>
