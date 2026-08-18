export * as ConfigPermissionReviewerV1 from "./permission-reviewer"

import { Schema } from "effect"

export const Info = Schema.Struct({
  mode: Schema.Literals(["audit-only", "enforce"]),
  model: Schema.NonEmptyString,
}).annotate({ identifier: "PermissionReviewerConfig" })

export type Info = Schema.Schema.Type<typeof Info>
