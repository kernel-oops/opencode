import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionDelegation } from "@opencode/core/session/delegation"
import { SessionEvent } from "@opencode/core/session/event"
import { NewSessionTable } from "@opencode/core/session/new-session.sql"
import { SessionExecution } from "@opencode/core/session/execution"
import { Global } from "@opencode/util/global"
import { delegatedOwner, effortLocations, effortRef } from "../../core/test/fixture/delegated-effort"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { globalProjectNode } from "../../core/test/lib/project"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

for (const ownership of ["closed", "missing"] as const) {
  it.live(
    `HTTP ${ownership} ownership effort rejection preserves the invalid-request contract and projection fence`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const context = yield* Layer.build(
          createEmbeddedRoutes(
            {
              app: { version: "test" },
              database: { path: `${directory.path}/ownership.sqlite` },
              models: { fetch: false },
              fs: { filewatcher: false },
            },
            [
              Global.node.replace(tempGlobalLayer),
              Bus.node.replace(Bus.configured({ persist: true })),
              Project.node.replace(globalProjectNode),
              LocationServiceMap.node.replace(effortLocations),
              SessionExecution.node.replace(SessionExecution.noopLayer),
            ],
          ).pipe(Layer.provide(HttpServer.layerServices)),
        )
        const sessions = Context.get(context, Session.Service)
        const db = Context.get(context, Database.Service).db
        const { owner } = yield* delegatedOwner(
          Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
        ).pipe(Effect.provide(context))
        if (ownership === "closed")
          yield* db
            .update(NewSessionTable)
            .set({ stage: "accepted" })
            .where(eq(NewSessionTable.session_id, owner.id))
            .run()
            .pipe(Effect.orDie)
        else yield* db.delete(NewSessionTable).where(eq(NewSessionTable.session_id, owner.id)).run().pipe(Effect.orDie)
        const handler = Context.get(context, HttpRouter.HttpRouter)
          .asHttpEffect()
          .pipe(HttpEffect.toWebHandlerWith(context))
        const post = (model: Model.Ref) =>
          Effect.promise(() =>
            handler(
              new Request(`http://opencode.local/api/session/${owner.id}/model`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model }),
              }),
            ),
          )
        const response = yield* post(effortRef("medium"))
        expect(response.status).toBe(400)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          _tag: "InvalidRequestError",
          message: "Delegated ownership is closed or unknown; further work is fenced",
        })
        expect(
          (yield* sessions.switchModel({ sessionID: owner.id, model: effortRef("medium") }).pipe(Effect.flip))._tag,
        ).toBe("Session.DelegationBlockedError")
        expect((yield* sessions.get(owner.id)).model).toEqual(effortRef())
        expect(yield* sessions.inbox(owner.id)).toHaveLength(0)
        expect((yield* SessionDelegation.get(db, owner.id))?.target_model).toEqual(effortRef())
        // Exact-ref no-ops retain their pre-existing semantics even when ownership is fenced.
        expect((yield* post(effortRef())).status).toBe(204)
        const bus = Context.get(context, Bus.Service)
        const projected = yield* bus
          .publish(SessionEvent.ModelSelected, {
            sessionID: owner.id,
            model: effortRef("medium"),
            previous: effortRef("medium"),
          })
          .pipe(Effect.provide(context), Effect.exit)
        expect(Exit.isFailure(projected) && Cause.hasDies(projected.cause)).toBe(true)
        const transaction = yield* db.transaction((tx) => SessionDelegation.open(tx, owner.id)).pipe(Effect.exit)
        expect(Exit.isFailure(transaction) && Cause.hasDies(transaction.cause)).toBe(true)
        expect((yield* sessions.get(owner.id)).model).toEqual(effortRef())
        expect(yield* sessions.inbox(owner.id)).toHaveLength(0)
      }),
  )
}

it.live("HTTP native picker changes model, provider and non-effort variant; baseline survives reopening", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const options = {
      app: { version: "test" },
      database: { path: `${directory.path}/effort.sqlite` },
      models: { fetch: false },
      fs: { filewatcher: false },
    }
    const replacements = [
      Global.node.replace(tempGlobalLayer),
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(effortLocations),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ]
    const boot = () =>
      Layer.build(createEmbeddedRoutes(options, replacements).pipe(Layer.provide(HttpServer.layerServices)))
    const retained = yield* Effect.gen(function* () {
      const context = yield* boot()
      const sessions = Context.get(context, Session.Service)
      const { owner } = yield* delegatedOwner(Location.Ref.make({ directory: AbsolutePath.make(directory.path) })).pipe(
        Effect.provide(context),
      )
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const post = (route: string, body: unknown) =>
        Effect.promise(() =>
          handler(
            new Request(`http://opencode.local${route}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          ),
        )
      expect((yield* post(`/api/session/${owner.id}/model`, { model: effortRef("medium") })).status).toBe(204)
      expect((yield* sessions.get(owner.id)).model).toEqual(effortRef("medium"))
      const selected = effortRef("wire", "alternate", "other")
      expect((yield* post(`/api/session/${owner.id}/model`, { model: selected })).status).toBe(204)
      expect((yield* sessions.get(owner.id)).model).toEqual(selected)
      expect(
        (yield* sessions
          .switchModel(
            Object.assign(
              { sessionID: owner.id, model: effortRef() },
              {
                human: true,
                source: "native",
                client_model: effortRef(),
              },
            ),
          )
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
      for (const model of [
        effortRef("unknown"),
        effortRef("medium", "disabled"),
        effortRef("medium", "missing"),
        null,
        {},
        { ...effortRef("medium"), variant: null },
      ]) {
        expect((yield* post(`/api/session/${owner.id}/model`, { model })).status).toBe(400)
        expect((yield* sessions.get(owner.id)).model).toEqual(selected)
        expect(yield* sessions.inbox(owner.id)).toHaveLength(0)
      }
      expect(Schema.decodeUnknownOption(Model.Ref)({ ...effortRef(), variant: null })._tag).toBe("None")
      yield* sessions.switchModel({ sessionID: owner.id, model: effortRef("wire-medium", "alternate", "other") })
      expect(
        (yield* post(`/api/session/${owner.id}/prompt`, { text: "Continue with medium", resume: false })).status,
      ).toBe(200)
      expect(yield* sessions.inbox(owner.id)).toHaveLength(1)
      return owner.id
    }).pipe(Effect.scoped)
    const reopened = yield* boot()
    const sessions = Context.get(reopened, Session.Service)
    const db = Context.get(reopened, Database.Service).db
    expect((yield* sessions.get(retained)).model).toEqual(effortRef("wire-medium", "alternate", "other"))
    expect((yield* SessionDelegation.get(db, retained))?.target_model).toEqual(effortRef())
    expect((yield* SessionDelegation.get(db, retained))?.client_model).toEqual(effortRef("wire", "alternate", "other"))
    yield* sessions.reconcileDelegatedModel(retained).pipe(Effect.provide(reopened))
    yield* sessions.switchModel({ sessionID: retained, model: effortRef("wire", "alternate", "other") })
    expect((yield* sessions.switchModel({ sessionID: retained, model: effortRef() }).pipe(Effect.exit))._tag).toBe(
      "Failure",
    )
    expect(yield* sessions.inbox(retained)).toHaveLength(1)
  }),
)
