import { expect, setDefaultTimeout } from "bun:test"
import path from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { Deferred, Duration, Effect, Fiber, Layer, LayerMap, Schedule, Scope, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Plugin } from "@opencode/core/plugin"
import { PluginModule } from "@opencode/core/plugin/module"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { SessionTable } from "@opencode/core/session/sql"
import { Session } from "@opencode/core/session"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { delegated, assertion } from "../fixture/delegated-permission"

setDefaultTimeout(15_000)
const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const watcher = yield* Watcher.Test
    const map = yield* LayerMap.make((ref: Location.Ref) => Instance.layer(ref, { replacements: bindings }), {
      idleTimeToLive: Duration.infinity,
    })
    const bindings: LayerNode.Replacements = [
      Global.node.replace(Layer.succeed(Global.Service, global)),
      offlineModels,
      Watcher.node.replace(Layer.succeed(Watcher.Service, watcher)),
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(
          Instance.Service,
          Instance.Service.of({ provide: (session) => Effect.provide(map.get(session.location)) }),
        ),
      ),
    ]
    return map
  }),
).pipe(Layer.provide(tempGlobalLayer), Layer.provide(Watcher.testLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SdkPlugins.node, Global.node, LocationServiceMap.node]),
    [Global.node.replace(tempGlobalLayer), offlineModels, LocationServiceMap.node.replace(instances)],
  ).pipe(Layer.provideMerge(Watcher.testLayer)),
)
const fixtureSource = `export default {
  id: "opencode-luna-permission-reviewer",
  async setup(ctx) {
    if (ctx.options.reject) throw new Error("replacement configuration rejected")
    await ctx.permission.hook("evaluate", event => { if (event.effect === "ask") event.effect = "allow" })
  }
}`
const pendingSource = `export default {
  id: "opencode-luna-permission-reviewer",
  async setup(ctx) {
    await ctx.permission.hook("evaluate", async event => {
      if (event.effect !== "ask") return
      if (event.resources[0] === "/pending") {
        await Bun.write(ctx.options.entered, "entered")
        while (!(await Bun.file(ctx.options.release).exists())) await Bun.sleep(1)
      }
      event.effect = "allow"
    })
  }
}`
const inInstance = <A, E>(
  body: () => Effect.Effect<A, E, Instance.Services | Global.Service | Database.Service | Bus.Service | Scope.Scope | Watcher.Test>,
) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const directory = yield* tmpdirScoped()
    const git = promisify(execFile)
    yield* Effect.promise(async () => {
      await git("git", ["init", "--quiet", directory.path])
      await git("git", [
        "-C",
        directory.path,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Fixture",
      ])
      await Bun.write(path.join(global.config, "plugins/luna-permission-reviewer/index.ts"), fixtureSource)
      await Bun.write(
        path.join(global.config, "opencode.json"),
        JSON.stringify({ plugins: [{ package: "./plugins/luna-permission-reviewer", options: { reject: false } }] }),
      )
    })
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const { db, creator } = yield* delegated
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "ask" }] })
        .where(eq(SessionTable.id, creator))
        .run()
        .pipe(Effect.orDie)
      return yield* body()
    }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))))
  })
const loadGeneration = (override?: Config.Interface) =>
  Effect.gen(function* () {
    const config = override ?? (yield* Config.Service)
    const location = yield* Location.Service
    const global = yield* Global.Service
    const extra = AppNodeBuilder.build(LayerNode.group([Config.node, ConfigPluginSource.node, Npm.node, Watcher.node]), [
      Config.node.replace(Layer.succeed(Config.Service, config)),
      Location.node.replace(Layer.succeed(Location.Service, location)),
      Global.node.replace(Layer.succeed(Global.Service, global)),
    ])
    return yield* Effect.gen(function* () {
      const scanner = yield* ConfigPluginSource.Service
      const operation = (yield* scanner.operations()).find(
        (item) => item.type === "add" && item.document === path.join(global.config, "opencode.json"),
      )
      if (!operation || operation.type !== "add") throw new Error("no actual global declaration")
      const modules = yield* PluginModule.make()
      const generation = yield* modules.load(operation)
      if (!("effect" in generation)) throw new Error("fixture load failed")
      expect(PluginModule.isSourceReviewer(generation)).toBe(true)
      expect(PluginModule.isModelReviewer(generation)).toBe(true)
      return generation
    }).pipe(Effect.provide(extra))
  })

it.live("actual enrolled Luna refusal can be approved once for the original delegated assertion", () =>
  inInstance(() => Effect.gen(function* () {
    const global = yield* Global.Service
    yield* Effect.promise(() => Bun.write(path.join(global.config, "plugins/luna-permission-reviewer/index.ts"), `export default {
      id: "opencode-luna-permission-reviewer",
      async setup(ctx) {
        await ctx.permission.hook("evaluate", event => {
          if (event.effect !== "ask") return
          event.effect = "deny"
          event.review = { kind: "model-refusal", reason: "Synthetic model refusal" }
        })
      }
    }`))
    const plugins = yield* Plugin.Service
    yield* plugins.activate([yield* loadGeneration()])
    const permission = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => event.type === Permission.Event.Asked.type
      ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid) : Effect.void)
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* permission.assert(assertion({
      metadata: { action: { identity: "read", complete: true, arguments: { path: "/synthetic" }, cwd: "/project" } },
      source: { type: "tool", messageID: "msg_fixture", id: "call_fixture" },
    })).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    expect(request.review?.kind).toBe("model-refusal")
    yield* permission.reply({ requestID: request.id, reply: "review_once" }, true)
    yield* Fiber.join(fiber)
    expect(yield* permission.list()).toEqual([])
  })),
)

it.live("actual supervisor preserves loader authentication for native delegated Permission.ask", () =>
  inInstance(() =>
    Effect.gen(function* () {
      yield* loadGeneration()
      const permission = yield* Permission.Service
      expect((yield* permission.ask(assertion({ resources: ["/external/PHP/symbols"] }))).effect).toBe("allow")
    }),
  ),
)
it.live("failed copied SDK replacement never resurrects source authority through fallback", () =>
  inInstance(() =>
    Effect.gen(function* () {
      const original = yield* loadGeneration()
      const plugins = yield* Plugin.Service
      const permission = yield* Permission.Service
      yield* plugins.activate([original])
      expect((yield* permission.ask(assertion())).effect).toBe("allow")
      yield* plugins.activate([{ ...original, effect: () => Effect.die(new Error("SDK replacement failed")) }])
      expect((yield* permission.ask(assertion())).effect).toBe("ask")
    }),
  ),
)
it.live("failed stricter authenticated generation never revives old permitting options", () =>
  inInstance(() =>
    Effect.gen(function* () {
      const original = yield* loadGeneration()
      const plugins = yield* Plugin.Service
      const permission = yield* Permission.Service
      yield* plugins.activate([original])
      expect((yield* permission.ask(assertion())).effect).toBe("allow")
      const global = yield* Global.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Document({
              type: "document",
              path: AbsolutePath.make(path.join(global.config, "opencode.json")),
              info: new Info({
                plugins: [{ package: "./plugins/luna-permission-reviewer", options: { reject: true } }],
              }),
            }),
          ]),
        changes: () => Stream.never,
      })
      yield* plugins.activate([yield* loadGeneration(config)])
      expect((yield* permission.ask(assertion())).effect).toBe("ask")
    }),
  ),
)
it.live("successful copied SDK replacement cannot review sources and target deny still wins", () =>
  inInstance(() =>
    Effect.gen(function* () {
      const original = yield* loadGeneration()
      const plugins = yield* Plugin.Service
      const permission = yield* Permission.Service
      yield* plugins.activate([original])
      expect((yield* permission.ask(assertion())).effect).toBe("allow")
      yield* plugins.activate([{ ...original }])
      expect((yield* permission.ask(assertion())).effect).toBe("ask")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "deny" }] })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      expect((yield* permission.ask(assertion())).effect).toBe("deny")
    }),
  ),
)

for (const failure of ["module", "setup"] as const) {
  it.live(`actual supervisor ${failure} failure retains ordinary callbacks but not stale source authority`, () =>
    inInstance(() =>
      Effect.gen(function* () {
        const permission = yield* Permission.Service
        const plugins = yield* Plugin.Service
        expect((yield* permission.ask(assertion())).effect).toBe("allow")
        const global = yield* Global.Service
        const watcher = yield* Watcher.Test
        const file = path.join(
          global.config,
          failure === "module" ? "plugins/luna-permission-reviewer/index.ts" : "opencode.json",
        )
        yield* Effect.promise(() =>
          Bun.write(
            file,
            failure === "module"
              ? "export default { syntax error"
              : JSON.stringify({
                  plugins: [{ package: "./plugins/luna-permission-reviewer", options: { reject: true } }],
                }),
          ),
        )
        yield* watcher.emit({ path: file, type: "update" })
        yield* plugins.list().pipe(
          Effect.flatMap((list) =>
            list.some((plugin) => plugin.state.status === "failed") ? Effect.void : Effect.fail("reload pending"),
          ),
          Effect.retry({ times: 80, schedule: Schedule.spaced("25 millis") }),
        )
        yield* plugins.awaitActivation
        expect((yield* permission.ask(assertion())).effect).toBe("ask")
        const hooks = yield* PluginHooks.Service
        expect(
          (yield* hooks.trigger("permission", "evaluate", {
            sessionID: Session.ID.make("ses_test"),
            action: "read",
            resources: ["/external/PHP"],
            effect: "ask",
          })).effect,
        ).toBe("allow")
      }),
    ),
  )
}

it.live("source authority is revoked before a replacement setup awaits or fails", () =>
  inInstance(() =>
    Effect.gen(function* () {
      const original = yield* loadGeneration()
      const plugins = yield* Plugin.Service
      const permission = yield* Permission.Service
      yield* plugins.activate([original])
      expect((yield* permission.ask(assertion())).effect).toBe("allow")
      const hooks = yield* PluginHooks.Service
      const receipt = yield* hooks.reviewSource({
        sessionID: Session.ID.make("ses_test"),
        action: "read",
        resources: ["/external/PHP"],
        effect: "ask",
      })
      expect(receipt.valid()).toBe(true)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const replacement = yield* plugins
        .activate([
          {
            ...original,
            effect: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return yield* Effect.die(new Error("replacement failed after waiting"))
              }),
          },
        ])
        .pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      expect(receipt.valid()).toBe(false)
      expect((yield* permission.ask(assertion())).effect).toBe("ask")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(replacement)
      expect((yield* permission.ask(assertion())).effect).toBe("ask")
    }),
  ),
)

for (const change of ["failed-replacement", "tightening"] as const) {
  it.live(`pending native source review cannot outrun ${change}`, () =>
    inInstance(() =>
      Effect.gen(function* () {
        const global = yield* Global.Service
        const directory = yield* tmpdirScoped()
        const entered = path.join(directory.path, "entered")
        const release = path.join(directory.path, "release")
        yield* Effect.promise(() =>
          Bun.write(path.join(global.config, "plugins/luna-permission-reviewer/index.ts"), pendingSource),
        )
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Document({
                type: "document",
                path: AbsolutePath.make(path.join(global.config, "opencode.json")),
                info: new Info({
                  plugins: [{ package: "./plugins/luna-permission-reviewer", options: { entered, release } }],
                }),
              }),
            ]),
          changes: () => Stream.never,
        })
        const generation = yield* loadGeneration(config)
        const plugins = yield* Plugin.Service
        const permission = yield* Permission.Service
        yield* plugins.activate([generation])
        expect((yield* permission.ask(assertion())).effect).toBe("allow")
        // Ensure the gate is released even if an assertion fails, so no fixture callback survives its scope.
        yield* Effect.addFinalizer(() => Effect.promise(() => Bun.write(release, "release")).pipe(Effect.asVoid))
        const pending = yield* permission.ask(assertion({ resources: ["/pending"] })).pipe(Effect.forkScoped)
        yield* Effect.promise(() => Bun.file(entered).exists()).pipe(
          Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail("review pending"))),
          Effect.retry({ times: 80, schedule: Schedule.spaced("25 millis") }),
        )
        if (change === "failed-replacement")
          yield* plugins.activate([{ ...generation, effect: () => Effect.die(new Error("replacement failed")) }])
        else {
          const { db } = yield* Database.Service
          yield* db
            .update(SessionTable)
            .set({ permission: [{ action: "read", resource: "*", effect: "deny" }] })
            .where(eq(SessionTable.id, Session.ID.make("ses_creator")))
            .run()
            .pipe(Effect.orDie)
        }
        yield* Effect.promise(() => Bun.write(release, "release"))
        expect((yield* Fiber.join(pending)).effect).toBe("deny")
        expect(yield* permission.list()).toEqual([])
        expect((yield* permission.ask(assertion())).effect).toBe(change === "failed-replacement" ? "ask" : "deny")
      }),
    ),
  )
}

// Optional cross-repository check of the actual Luna reviewer module (config repository) inside this actual host:
// set OPENCODE_LUNA_REVIEWER_MODULE to its directory. Only the model catalogue and generations are scripted; the
// permission service, enrolment, session services and hook chain are the real ones. Skipped when unset.
const lunaModule = process.env.OPENCODE_LUNA_REVIEWER_MODULE
// The script is inlined in the module source: the host's config service is already loaded, so new options would not apply.
const contextualWrapper = (script: unknown, humanReview = "deny") => `import Real from "./real/index.ts"
const LUNA = { id: "gpt-6-luna", modelID: "gpt-6-luna", providerID: "openai" }
const SOL = { id: "gpt-6.1-sol", modelID: "gpt-6.1-sol", providerID: "openai" }
export default {
  id: "opencode-luna-permission-reviewer",
  async setup(ctx) {
    const script = ${JSON.stringify(script)}
    const calls = (globalThis.__contextualCalls = { luna: 0, sol: 0 })
    return Real.setup({
      permission: ctx.permission, session: ctx.session, location: ctx.location, tool: ctx.tool,
      options: { mode: "enforce", model: "openai/gpt-6-luna", policy: "exceptional-risk-only-v1", automatic_allow: "policy-gated",
        automatic_rewrite: "once-per-turn", human_review: ${JSON.stringify(humanReview)}, standing_rules_file: "" },
      model: { list: async () => ({ data: [LUNA, SOL] }) },
      generate: { text: async ({ model, responseSchema }) => {
        if (model.id === LUNA.id) {
          calls.luna++
          const value = script.luna.outcome ? { decision: [script.luna.outcome, script.luna.reason_code, script.luna.safer_alternative].join(":") } : script.luna
          return { responseSchemaName: responseSchema?.name, text: JSON.stringify(value) }
        }
        calls.sol++
        if (script.sol === "fail") throw new Error("contextual model unavailable")
        return { text: JSON.stringify({ decision: script.sol }) }
      } },
    })
  },
}`
const contextualCalls = () => (globalThis as unknown as { __contextualCalls: { luna: number; sol: number } }).__contextualCalls
const installContextual = (script: unknown, humanReview = "deny") =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    yield* Effect.promise(async () => {
      const { readdir } = await import("node:fs/promises")
      const target = path.join(global.config, "plugins/luna-permission-reviewer")
      for (const file of await readdir(lunaModule!))
        if (file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "test-setup.ts")
          await Bun.write(path.join(target, "real", file), Bun.file(path.join(lunaModule!, file)))
      await Bun.write(path.join(target, "index.ts"), contextualWrapper(script, humanReview))
    })
    const plugins = yield* Plugin.Service
    yield* plugins.activate([yield* loadGeneration()])
  })
const boundRead = {
  metadata: { action: { identity: "read", complete: true, arguments: { path: "/synthetic" }, cwd: "/project" } },
  source: { type: "tool" as const, messageID: "msg_fixture", id: "call_fixture" },
}
it.live("unattended delegated messages use ordinary source precedence and fallbacks", () =>
  inInstance(() => Effect.gen(function* () {
    const global = yield* Global.Service
    const plugins = yield* Plugin.Service
    const permission = yield* Permission.Service
    for (const [target, source, selected] of [
      ["target explanation", "source explanation", "source explanation"],
      ["target explanation", undefined, "target explanation"],
      ["target explanation", "", ""],
      [undefined, undefined, undefined],
    ]) {
      yield* Effect.promise(() => Bun.write(path.join(global.config, "plugins/luna-permission-reviewer/index.ts"), `export default {
        id: "opencode-luna-permission-reviewer",
        async setup(ctx) {
          let calls = 0
          await ctx.permission.hook("evaluate", event => {
            event.message = (++calls % 2 ? ${JSON.stringify(target)} : ${JSON.stringify(source)})
          })
        }
      }`))
      yield* plugins.activate([yield* loadGeneration()])
      const ordinary = yield* permission.ask(assertion())
      expect(ordinary.effect).toBe("ask")
      const [request] = yield* permission.list()
      expect(request?.message).toBe(selected)
      yield* permission.reply({ requestID: ordinary.id, reply: "reject" })
      const blocked = yield* permission.assert(assertion()).pipe(
        Effect.provideService(Permission.Unattended, []), Effect.flip,
      )
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(blocked.message).toBe([
        "Permission read needs approval, and nobody is present to give it", selected,
      ].filter(Boolean).join(". "))
      expect(yield* permission.list()).toEqual([])
    }
  })),
)
const humanReview = { outcome: "human_review", reason_code: "comparable_exceptional_harm", safer_alternative: "request_specific_authorisation" }
const rewrite = { outcome: "rewrite", reason_code: "destructive_or_irreversible", safer_alternative: "use_dry_run" }

if (lunaModule) {
  it.live("actual module: unattended human review retains the blocker without a pending request", () =>
    inInstance(() => Effect.gen(function* () {
      yield* installContextual({ luna: { decision: "human_review:high_impact_identity_auth_or_security_change:request_specific_authorisation" }, sol: "fail" }, "ask")
      const permission = yield* Permission.Service
      const blocked = yield* permission.assert(assertion(boundRead)).pipe(
        Effect.provideService(Permission.Unattended, []), Effect.flip,
      )
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
      expect(blocked.message).toContain("nobody is present to give it")
      expect(blocked.message).toContain("Permission blocker: Marc's review is required")
      expect(blocked.message).toContain("parent/controller")
      expect(yield* permission.list()).toEqual([])
      const { db } = yield* Database.Service
      yield* db.update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "deny" }] })
        .where(eq(SessionTable.id, Session.ID.make("ses_test"))).run().pipe(Effect.orDie)
      const hard = yield* permission.assert(assertion(boundRead)).pipe(
        Effect.provideService(Permission.Unattended, []), Effect.flip,
      )
      expect(hard).toBeInstanceOf(Permission.BlockedError)
      expect(hard.message).not.toContain("Permission blocker: Marc's review is required")
      expect(yield* permission.list()).toEqual([])
    })),
  )
  it.live("actual module: a rewrite whose contextual review fails waits as an ordinary ask that a human reply settles", () =>
    inInstance(() => Effect.gen(function* () {
      yield* installContextual({ luna: rewrite, sol: "fail" })
      const permission = yield* Permission.Service
      const bus = yield* Bus.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const unsubscribe = yield* bus.listen((event) => event.type === Permission.Event.Asked.type
        ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid) : Effect.void)
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* permission.assert(assertion(boundRead)).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      expect(request.review).toBeUndefined()
      expect(contextualCalls()).toEqual({ luna: 1, sol: 1 })
      yield* permission.reply({ requestID: request.id, reply: "once" }, true)
      yield* Fiber.join(fiber)
      expect(yield* permission.list()).toEqual([])
    })),
  )
  it.live("actual module: a contextual allow is published by the host; a configured deny never reaches either model", () =>
    inInstance(() => Effect.gen(function* () {
      yield* installContextual({ luna: humanReview, sol: { outcome: "allow", reason_code: "specifically_authorised_operation", safer_alternative: "none" } })
      const permission = yield* Permission.Service
      expect((yield* permission.ask(assertion(boundRead))).effect).toBe("allow")
      expect(contextualCalls()).toEqual({ luna: 1, sol: 1 })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ permission: [{ action: "read", resource: "*", effect: "deny" }] })
        .where(eq(SessionTable.id, Session.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      expect((yield* permission.ask(assertion(boundRead))).effect).toBe("deny")
      expect(contextualCalls()).toEqual({ luna: 1, sol: 1 })
    })),
  )
}
