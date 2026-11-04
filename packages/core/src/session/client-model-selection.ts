/** Internal native-client capability; never part of a Session, event or plugin input. */
export * as ClientModelSelection from "./client-model-selection.js"

import { Context, Effect, Option } from "effect"
import type { Event } from "@opencode/schema/event"
import type { Model } from "@opencode/schema/model"
import type { SessionSchema } from "./schema.js"

type Selection = { eventID: Event.ID; sessionID: SessionSchema.ID; model: Model.Ref }
class Capability extends Context.Service<Capability, Selection>()("@opencode/private/ClientModelSelection") {}

export const provide = <A, E, R>(selection: Selection, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Capability, selection)

export const matches = (sessionID: SessionSchema.ID, model: Model.Ref, eventID?: Event.ID) =>
  Effect.serviceOption(Capability).pipe(
    Effect.map(
      (capability) =>
        Option.isSome(capability) &&
        capability.value.eventID === eventID &&
        capability.value.sessionID === sessionID &&
        capability.value.model.id === model.id &&
        capability.value.model.providerID === model.providerID &&
        (capability.value.model.variant ?? "default") === (model.variant ?? "default"),
    ),
  )
