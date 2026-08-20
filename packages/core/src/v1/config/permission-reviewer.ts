export * as ConfigPermissionReviewerV1 from "./permission-reviewer"

import { Effect, Schema } from "effect"

export const Info = Schema.Struct({
  mode: Schema.Literals(["audit-only", "enforce"]),
  model: Schema.NonEmptyString,
  automatic_allow: Schema.Literal("never")
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("never" as const)))
    .annotate({
      description: 'Local automatic-allow policy. Defaults to "never".',
    }),
}).annotate({ identifier: "PermissionReviewerConfig" })

export type Info = Schema.Schema.Type<typeof Info>
