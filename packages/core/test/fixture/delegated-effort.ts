import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Image } from "@opencode/core/image"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import type { FileSystem } from "@opencode/core/filesystem"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Skill } from "@opencode/core/skill"
import { Session } from "@opencode/core/session"
import { SessionDelegation } from "@opencode/core/session/delegation"
import { SessionMessage } from "@opencode/core/session/message"
import { NewSessionTable } from "@opencode/core/session/new-session.sql"
import { Location } from "@opencode/core/location"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, LayerMap } from "effect"

export const effortModel = (id = "fixture", enabled = true) =>
  Model.Info.make({
    id: Model.ID.make(id),
    providerID: Provider.ID.make("fixture"),
    modelID: Model.ID.make("wire"),
    name: "Fixture",
    package: "@opencode/ai/providers/openai",
    enabled,
    status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 1000, output: 100 },
    time: { released: 0 },
    settings: { reasoningEffort: "high", thinking: { type: "adaptive" } },
    headers: { "x-account": "fixture" },
    body: { model: "wire" },
    variants: [
      { id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } },
      { id: Model.VariantID.make("medium"), settings: { reasoningEffort: "medium" } },
      { id: Model.VariantID.make("ordinary"), settings: { reasoningEffort: "medium", thinking: { type: "adaptive" } } },
      { id: Model.VariantID.make("extreme"), settings: { reasoningEffort: "xhigh" } },
      { id: Model.VariantID.make("max"), settings: { effort: "max" } },
      {
        id: Model.VariantID.make("endpoint"),
        settings: { reasoningEffort: "medium", baseURL: "https://invalid.example" },
      },
      { id: Model.VariantID.make("key"), settings: { reasoningEffort: "medium", apiKey: "fixture-other" } },
      { id: Model.VariantID.make("account"), settings: { account: "other" } },
      { id: Model.VariantID.make("header"), headers: { "x-account": "other" } },
      { id: Model.VariantID.make("wire"), body: { model: "other" } },
      { id: Model.VariantID.make("wire-medium"), body: { model: "other" }, settings: { reasoningEffort: "medium" } },
      { id: Model.VariantID.make("thinking"), settings: { thinking: { type: "enabled", budgetTokens: 100 } } },
    ],
  })
export const effortRef = (variant = "high", id = "fixture", provider = "fixture") =>
  Model.Ref.make({
    id: Model.ID.make(id),
    providerID: Provider.ID.make(provider),
    variant: Model.VariantID.make(variant),
  })

export const effortLocations = makeGlobalNode({
  service: LocationServiceMap.Service,
  deps: [Bus.node],
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const catalogue = [
        effortModel(),
        effortModel("specialist"),
        effortModel("alias"),
        effortModel("disabled", false),
        Model.Info.make({ ...effortModel("alternate"), providerID: Provider.ID.make("other") }),
      ]
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          Layer.merge(
            LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node, Skill.node, Plugin.node]), {
              replacements: [
                Bus.node.replace(Layer.succeed(Bus.Service, bus)),
                Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
              ],
            }),
            Layer.mock(Model.Service, {
              available: () => Effect.succeed(catalogue.filter((model) => model.enabled)),
              get: (provider, id) =>
                Effect.succeed(catalogue.find((model) => model.providerID === provider && model.id === id)),
              default: () => Effect.succeed(catalogue[0]),
            }),
          ) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
})

export const delegatedOwner = Effect.fn(function* (location: Location.Ref) {
  const sessions = yield* Session.Service
  const db = (yield* Database.Service).db
  const creator = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: effortRef() })
  const owner = yield* sessions.create({ location, agent: Agent.ID.make("build"), model: effortRef() })
  yield* db
    .insert(NewSessionTable)
    .values({
      id: owner.id,
      creator_id: creator.id,
      launch_key: owner.id,
      payload_hash: "fixture",
      payload: "{}",
      project_id: owner.projectID,
      ownership_key: owner.id,
      canonical: location.directory,
      workdir: location.directory,
      directory_identity: "fixture",
      session_id: owner.id,
      prompt_id: SessionMessage.ID.create(),
      notification_id: SessionMessage.ID.create(),
      stage: "running",
      time_created: 0,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionDelegation.Table)
    .values({
      session_id: owner.id,
      origin_id: owner.id,
      creator_id: creator.id,
      source_agent: Agent.ID.make("build"),
      source_directory: location.directory,
      source_directory_identity: "fixture",
      agent_rules: [],
      session_rules: [],
      target_agent: Agent.ID.make("build"),
      target_model: effortRef(),
    })
    .run()
    .pipe(Effect.orDie)
  return { creator, owner }
})
