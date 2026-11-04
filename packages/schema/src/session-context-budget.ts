export * as SessionContextBudget from "./session-context-budget.js"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "./schema.js"
import { Model } from "./model.js"

/** Estimated total tokens, including the requested output reserve; not an exact provider-token ceiling. */
export const Policy = Schema.Struct({ target: PositiveInt, maximum: PositiveInt }).annotate({
  identifier: "Session.ContextBudget",
})
export interface Policy extends Schema.Schema.Type<typeof Policy> {}

export const Blocked = Schema.Struct({
  reason: Schema.String,
  model: Model.Ref.pipe(optional),
  inputMargin: Schema.Finite.pipe(optional),
  estimated: NonNegativeInt.pipe(optional),
  raw: NonNegativeInt.pipe(optional),
  replayGenerated: NonNegativeInt.pipe(optional),
  input: NonNegativeInt.pipe(optional),
  output: NonNegativeInt.pipe(optional),
  inputMaximum: NonNegativeInt.pipe(optional),
  contextMaximum: NonNegativeInt.pipe(optional),
  maximum: PositiveInt,
  /** Selected model at admission, so a model switch can request a fresh local check. */
  selection: Schema.String,
}).annotate({ identifier: "Session.ContextBudgetBlocked" })
export interface Blocked extends Schema.Schema.Type<typeof Blocked> {}

/** Irreducible admission facts, retained across ordinary inputs and process restarts. */
export const State = Schema.Struct({
  attempted: Schema.Struct({ binding: Schema.String, estimated: NonNegativeInt }).pipe(optional),
  blocked: Blocked.pipe(optional),
}).annotate({ identifier: "Session.ContextBudgetState" })
export interface State extends Schema.Schema.Type<typeof State> {}
