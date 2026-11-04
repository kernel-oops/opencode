import { expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Schema } from "effect"
import { Document, Info } from "@opencode/schema/config"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Database } from "@opencode/core/database/database"
import type { FileSystem } from "@opencode/core/filesystem"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { SessionClientModel } from "@opencode/core/session/client-model"
import { SessionDelegation } from "@opencode/core/session/delegation"
import { delegatedOwner, effortRef } from "./fixture/delegated-effort"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

it.effect("native selection waits for its location's real plugin activation before reading the catalogue", () =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    const { owner } = yield* delegatedOwner(location)
    const sessions = yield* Session.Service
    const plugins = yield* Plugin.Service
    const models = yield* Model.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const waiting = yield* Deferred.make<void>()
    const activation = yield* plugins
      .activate([
        {
          id: "fixture.cold-catalogue",
          revision: "1",
          effect: (host) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
                Effect.provide(
                  Config.testLayer([
                    new Document({
                      type: "document",
                      info: Schema.decodeUnknownSync(Info)({
                        providers: {
                          other: {
                            package: "@opencode/ai/providers/openai",
                            models: {
                              alternate: { variants: [{ id: "wire", body: { model: "alternative" } }] },
                            },
                          },
                        },
                      }),
                    }),
                  ]),
                ),
              )
            }),
        },
      ])
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(entered)
    expect((yield* models.available()).some((model) => model.providerID === "other")).toBe(false)
    const context = Context.make(Model.Service, models).pipe(
      Context.add(Plugin.Service, {
        ...plugins,
        awaitActivation: Deferred.succeed(waiting, undefined).pipe(Effect.andThen(plugins.awaitActivation)),
      }),
    )
    // Only these services are read from the cached location; both implementations are real, not always-ready mocks.
    const locations = (yield* LayerMap.make((_ref: Location.Ref) =>
      Layer.succeedContext(context),
    )) as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, FileSystem.DirectoryNotFoundError>
    const selected = effortRef("wire", "alternate", "other")
    const selection = yield* SessionClientModel.select({ sessionID: owner.id, model: selected }).pipe(
      Effect.provideService(LocationServiceMap.Service, locations),
      Effect.exit,
      Effect.forkChild({ startImmediately: true }),
    )
    const observed = yield* Effect.race(
      Deferred.await(waiting).pipe(Effect.as("waiting")),
      Fiber.join(selection).pipe(Effect.as("completed")),
    )
    const pending = selection.pollUnsafe()
    const baseline = (yield* SessionDelegation.get((yield* Database.Service).db, owner.id))?.client_model
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(activation)
    expect(observed).toBe("waiting")
    expect(pending).toBeUndefined()
    expect(baseline).toBeNull()
    expect(Exit.isSuccess(yield* Fiber.join(selection))).toBe(true)
    expect((yield* sessions.get(owner.id)).model).toEqual(selected)
  }),
)
