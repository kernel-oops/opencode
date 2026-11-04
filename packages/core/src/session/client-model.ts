export * as SessionClientModel from "./client-model.js"

import { Context, Effect } from "effect"
import { Event } from "@opencode/schema/event"
import type { Model } from "@opencode/schema/model"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Plugin } from "../plugin/service.js"
import { ClientModelSelection } from "./client-model-selection.js"
import { SessionDelegation } from "./delegation.js"
import { SessionEvent } from "./event.js"
import type { SessionSchema } from "./schema.js"
import { Session } from "../session.js"

type Input = {
  sessionID: SessionSchema.ID
  model: Model.Ref
}

/** Capture host services at server construction, not from the HTTP request context. */
export const make = Effect.fn("SessionClientModel.make")(function* () {
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  const database = yield* Database.Service
  const locations = yield* LocationServiceMap.Service
  return Effect.fn("SessionClientModel.select")(function* (input: Input) {
    const session = yield* sessions.get(input.sessionID)
    if (
      session.model?.providerID === input.model.providerID &&
      session.model.id === input.model.id &&
      (session.model.variant ?? "default") === (input.model.variant ?? "default")
    )
      return
    const eventID = Event.ID.create()
    const publish = bus.publish(SessionEvent.ModelSelected, { ...input, previous: session.model }, { id: eventID })
    if (!(yield* SessionDelegation.get(database.db, input.sessionID))) return yield* publish.pipe(Effect.asVoid)
    yield* ClientModelSelection.provide(
      { ...input, eventID },
      Effect.gen(function* () {
        const context = yield* locations.contextEffect(session.location)
        yield* Context.get(context, Plugin.Service).awaitActivation
        yield* SessionDelegation.assertModelTransition(database.db, input.sessionID, input.model, false, eventID)
        yield* publish
      }),
    ).pipe(
      Effect.scoped,
      Effect.provideService(LocationServiceMap.Service, locations),
      Effect.catchTag("FileSystem.DirectoryNotFoundError", () =>
        Effect.fail(
          new SessionDelegation.BlockedError({
            sessionID: input.sessionID,
            message: "Delegated model catalogue is unavailable",
          }),
        ),
      ),
    )
  })
})

/** Authenticated native client control, deliberately absent from the plugin Session host. */
export const select = Effect.fn("SessionClientModel.select")(function* (input: Input) {
  const select = yield* make()
  yield* select(input)
})
