import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit, Stream } from "effect"
import { Event } from "@opencode/schema/event"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionDelegation } from "@opencode/core/session/delegation"
import { SessionClientModel } from "@opencode/core/session/client-model"
import { ClientModelSelection } from "@opencode/core/session/client-model-selection"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { NewSessionTable } from "@opencode/core/session/new-session.sql"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { delegatedOwner, effortLocations, effortModel, effortRef } from "./fixture/delegated-effort"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Session.node,
      SessionStore.node,
      SessionProjector.node,
      LocationServiceMap.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(effortLocations),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/fixture") })

describe("delegated reasoning effort", () => {
  it.effect("native selection persists only an exact-session baseline and workers remain effort-only", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const db = (yield* Database.Service).db
      const { owner } = yield* delegatedOwner(location)
      const before = yield* SessionDelegation.get(db, owner.id)
      if (!before) throw new Error("Missing delegation")
      const selected = effortRef("wire", "alternate", "other")
      yield* SessionClientModel.select({ sessionID: owner.id, model: selected })
      expect((yield* sessions.get(owner.id)).model).toEqual(selected)
      expect(yield* SessionDelegation.get(db, owner.id)).toEqual({ ...before, client_model: selected })
      // Duplicate delivery is idempotent; replay is not a second authority channel.
      const events = yield* Stream.runCollect(bus.log({ aggregateID: owner.id, follow: false }))
      const recorded = events
        .filter((event): event is Event.Payload => !Bus.isSynced(event))
        .find((event) => event.type === SessionEvent.ModelSelected.type)!
      if (!recorded.durable) throw new Error("Missing selection event")
      yield* bus.replay({
        id: recorded.id,
        created: recorded.created,
        type: Bus.versionedType(recorded.type, recorded.durable.version),
        aggregateID: owner.id,
        seq: recorded.durable.seq,
        data: recorded.data as Record<string, unknown>,
      })
      for (const model of [effortRef(), effortRef("medium", "alternate", "other")]) {
        expect((yield* sessions.switchModel({ sessionID: owner.id, model }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(
          (yield* bus
            .publish(
              SessionEvent.ModelSelected,
              {
                sessionID: owner.id,
                model,
                previous: model,
              },
              { metadata: { human: true, source: "native", client_model: model } },
            )
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        const replayed = yield* bus
          .replay({
            id: Event.ID.create(),
            type: Bus.versionedType(SessionEvent.ModelSelected.type, 1),
            aggregateID: owner.id,
            seq: (yield* Bus.latestSequence(db, owner.id)) + 1,
            data: { sessionID: owner.id, model, previous: selected, human: true },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(replayed) && Cause.pretty(replayed.cause)).toContain("Delegated model changes")
      }
      yield* sessions.switchModel({ sessionID: owner.id, model: effortRef("wire-medium", "alternate", "other") })
      yield* sessions.reconcileDelegatedModel(owner.id)
      const child = yield* sessions.create({ parentID: owner.id, model: effortRef("high", "specialist") })
      expect((yield* SessionDelegation.get(db, child.id))?.client_model).toBeNull()
      expect((yield* sessions.switchModel({ sessionID: child.id, model: selected }).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      yield* sessions.append({ sessionID: owner.id, text: "Fork evidence", final: true })
      const fork = yield* sessions.fork({ sessionID: owner.id })
      expect((yield* SessionDelegation.get(db, fork.id))?.client_model).toBeNull()
      expect((yield* sessions.switchModel({ sessionID: fork.id, model: effortRef() }).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      expect((yield* SessionDelegation.get(db, owner.id))?.target_model).toEqual(effortRef())
    }),
  )
  it.effect("native capability is bound to event, session and complete model; invalid selections admit nothing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const db = (yield* Database.Service).db
      const { owner } = yield* delegatedOwner(location)
      const other = yield* sessions.create({ location })
      const sequence = yield* Bus.latestSequence(db, owner.id)
      yield* (yield* LocationServiceMap.Service).contextEffect(location)
      const eventID = Event.ID.create()
      const selected = effortRef("wire", "alternate", "other")
      for (const selection of [
        { eventID: Event.ID.create(), sessionID: owner.id, model: selected },
        { eventID, sessionID: other.id, model: selected },
        { eventID, sessionID: owner.id, model: effortRef("wire-medium", "alternate", "other") },
        { eventID, sessionID: owner.id, model: effortRef("wire", "alias") },
        { eventID, sessionID: owner.id, model: effortRef("wire", "alternate", "fixture") },
      ]) {
        const projected = yield* ClientModelSelection.provide(
          selection,
          bus.publish(SessionEvent.ModelSelected, { sessionID: owner.id, model: selected }, { id: eventID }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(projected) && Cause.pretty(projected.cause)).toContain("Delegated model changes")
      }
      for (const model of [effortRef("unknown"), effortRef("high", "disabled"), effortRef("high", "missing")])
        expect((yield* SessionClientModel.select({ sessionID: owner.id, model }).pipe(Effect.exit))._tag).toBe(
          "Failure",
        )
      expect((yield* sessions.get(owner.id)).model).toEqual(effortRef())
      expect((yield* SessionDelegation.get(db, owner.id))?.client_model).toBeNull()
      expect(yield* sessions.inbox(owner.id)).toHaveLength(0)
      expect(yield* Bus.latestSequence(db, owner.id)).toBe(sequence)
    }),
  )
  it.effect("ownership closing between native preflight and publication cannot commit a baseline", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const db = (yield* Database.Service).db
      const { owner } = yield* delegatedOwner(location)
      const closingBus: Bus.Interface = {
        ...bus,
        publish: (definition, data, options) =>
          Effect.gen(function* () {
            yield* db
              .update(NewSessionTable)
              .set({ stage: "accepted" })
              .where(eq(NewSessionTable.session_id, owner.id))
              .run()
              .pipe(Effect.orDie)
            return yield* bus.publish(definition, data, options)
          }),
      }
      expect(
        (yield* SessionClientModel.select({ sessionID: owner.id, model: effortRef("wire", "alias") }).pipe(
          Effect.provideService(Bus.Service, closingBus),
          Effect.exit,
        ))._tag,
      ).toBe("Failure")
      expect((yield* sessions.get(owner.id)).model).toEqual(effortRef())
      expect((yield* SessionDelegation.get(db, owner.id))?.client_model).toBeNull()
    }),
  )
  it.effect("recognises only the five effort leaves, not nested thinking or similarly named fields", () =>
    Effect.gen(function* () {
      for (const settings of [
        { settings: { reasoningEffort: "high" }, overlay: { settings: { reasoningEffort: "medium" } } },
        { settings: { effort: "high" }, overlay: { settings: { effort: "medium" } } },
        {
          settings: { reasoning: { effort: "high", summary: "auto" } },
          overlay: { settings: { reasoning: { effort: "medium" } } },
        },
        { body: { reasoning_effort: "high" }, overlay: { body: { reasoning_effort: "medium" } } },
        {
          body: { reasoning: { effort: "high", summary: "auto" } },
          overlay: { body: { reasoning: { effort: "medium" } } },
        },
      ]) {
        const model = Model.Info.make({
          ...effortModel(),
          settings: settings.settings,
          body: settings.body,
          variants: [{ id: Model.VariantID.make("arbitrary"), ...settings.overlay }],
        })
        expect(yield* ModelResolver.effortTransition(model, undefined, Model.VariantID.make("arbitrary"))).toBe(true)
      }
      for (const settings of [
        { thinking: { effort: "medium" } },
        { other: { effort: "medium" } },
        { reasoningEffort: "Ultra" },
        { reasoningEffort: 2 },
        { reasoningEffort: "unknown" },
      ]) {
        const model = Model.Info.make({
          ...effortModel(),
          variants: [{ id: Model.VariantID.make("medium"), settings }],
        })
        expect(yield* ModelResolver.effortTransition(model, undefined, Model.VariantID.make("medium"))).toBe(false)
      }
    }),
  )
  it.effect("uses configured values, preserving every non-effort field", () =>
    Effect.gen(function* () {
      const model = effortModel()
      for (const variant of ["medium", "ordinary", "default"])
        expect(yield* ModelResolver.effortTransition(model, effortRef().variant, effortRef(variant).variant)).toBe(true)
      for (const variant of ["extreme", "max", "endpoint", "key", "account", "header", "wire", "thinking"])
        expect(yield* ModelResolver.effortTransition(model, effortRef().variant, effortRef(variant).variant)).toBe(
          false,
        )
      expect(
        yield* ModelResolver.effortTransition(model, effortRef("extreme").variant, effortRef("extreme").variant),
      ).toBe(true)
      expect(
        yield* ModelResolver.effortTransition(model, effortRef("extreme").variant, effortRef("medium").variant),
      ).toBe(true)
    }),
  )
  it.effect("API and projector accept effort, retain immutable provenance and admit subsequent prompts", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const db = (yield* Database.Service).db
      const { owner } = yield* delegatedOwner(location)
      yield* sessions.switchModel({ sessionID: owner.id, model: effortRef("medium") })
      expect((yield* sessions.get(owner.id)).model).toEqual(effortRef("medium"))
      yield* sessions.prompt({ sessionID: owner.id, text: "Continue without relaunch", resume: false })
      expect(yield* sessions.inbox(owner.id)).toHaveLength(1)
      const locations = yield* LocationServiceMap.Service
      yield* locations.contextEffect((yield* sessions.get(owner.id)).location)
      yield* bus.publish(SessionEvent.ModelSelected, {
        sessionID: owner.id,
        model: effortRef("ordinary"),
        previous: effortRef("wire"),
      })
      expect((yield* sessions.get(owner.id)).model?.variant).toBe(Model.VariantID.make("ordinary"))
      yield* sessions.switchModel({
        sessionID: owner.id,
        model: { id: effortRef().id, providerID: effortRef().providerID },
      })
      expect((yield* sessions.get(owner.id)).model?.variant).toBe(Model.VariantID.make("default"))
      expect((yield* SessionDelegation.get(db, owner.id))?.target_model).toEqual(effortRef())
    }),
  )
  it.effect("specialist children, forks and unset children keep their own effective catalogue model", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { owner } = yield* delegatedOwner(location)
      const child = yield* sessions.create({
        parentID: owner.id,
        agent: Agent.ID.make("specialist"),
        model: effortRef("high", "specialist"),
      })
      yield* sessions.switchModel({ sessionID: child.id, model: effortRef("medium", "specialist") })
      yield* sessions.append({ sessionID: child.id, text: "Evidence", final: true })
      const fork = yield* sessions.fork({ sessionID: child.id })
      yield* sessions.switchModel({ sessionID: fork.id, model: effortRef("high", "specialist") })
      expect((yield* sessions.get(fork.id)).model?.id).toBe(Model.ID.make("specialist"))
      const unset = yield* sessions.create({ parentID: owner.id, agent: Agent.ID.make("specialist") })
      yield* sessions.switchModel({ sessionID: unset.id, model: effortRef("medium") })
      expect((yield* sessions.get(unset.id)).model?.variant).toBe(Model.VariantID.make("medium"))
    }),
  )
  it.effect("rejects catalogue and non-effort deviations before durable model or prompt admission", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const { owner } = yield* delegatedOwner(location)
      for (const model of [
        effortRef("medium", "alias"),
        effortRef("medium", "disabled"),
        effortRef("medium", "missing"),
        {
          ...effortRef("medium"),
          providerID: Model.Ref.make({ id: effortRef().id, providerID: "other" as never }).providerID,
        },
        ...["extreme", "max", "endpoint", "key", "account", "header", "wire", "thinking", "unknown"].map((variant) =>
          effortRef(variant),
        ),
      ]) {
        expect((yield* sessions.switchModel({ sessionID: owner.id, model }).pipe(Effect.exit))._tag).toBe("Failure")
        expect(
          (yield* bus
            .publish(SessionEvent.ModelSelected, { sessionID: owner.id, model, previous: model })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        expect((yield* sessions.get(owner.id)).model).toEqual(effortRef())
        expect(yield* sessions.inbox(owner.id)).toHaveLength(0)
      }
      yield* sessions.setMetadata({ sessionID: owner.id, metadata: { origin: "human" } })
      expect(
        (yield* sessions.switchAgent({ sessionID: owner.id, agent: Agent.ID.make("other") }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        (yield* sessions.move({ sessionID: owner.id, directory: AbsolutePath.make("/other") }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      const next = yield* Bus.latestSequence((yield* Database.Service).db, owner.id)
      expect(
        (yield* bus
          .replay({
            id: "evt_forged_effort" as never,
            type: Bus.versionedType(SessionEvent.ModelSelected.type, 1),
            aggregateID: owner.id,
            seq: next + 1,
            data: { sessionID: owner.id, model: effortRef("wire"), previous: effortRef("wire") },
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
    }),
  )
  it.effect("direct events cannot construct a cold catalogue; closed ownership remains fenced", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const db = (yield* Database.Service).db
      const { owner } = yield* delegatedOwner(Location.Ref.make({ directory: AbsolutePath.make("/cold") }))
      expect(
        (yield* bus
          .publish(SessionEvent.ModelSelected, { sessionID: owner.id, model: effortRef("medium") })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
      yield* sessions.switchModel({ sessionID: owner.id, model: effortRef("medium") })
      yield* db
        .update(NewSessionTable)
        .set({ stage: "accepted" })
        .where(eq(NewSessionTable.session_id, owner.id))
        .run()
        .pipe(Effect.orDie)
      expect(
        (yield* sessions.switchModel({ sessionID: owner.id, model: effortRef("high") }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(
        (yield* sessions.prompt({ sessionID: owner.id, text: "Fenced", resume: false }).pipe(Effect.exit))._tag,
      ).toBe("Failure")
      yield* sessions.switchModel({ sessionID: owner.id, model: effortRef("medium") })
    }),
  )
  it.effect("unrestricted sessions retain ordinary model-switch behaviour", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const ordinary = yield* sessions.create({ location, model: effortRef() })
      yield* sessions.switchModel({ sessionID: ordinary.id, model: effortRef("extreme", "alias") })
      expect((yield* sessions.get(ordinary.id)).model).toEqual(effortRef("extreme", "alias"))
    }),
  )
})
