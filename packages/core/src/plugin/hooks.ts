export * as PluginHooks from "./hooks.js"

import type { AISDKHooks } from "@opencode/plugin/effect/aisdk"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellHooks } from "@opencode/plugin/effect/shell"
import type { ToolFailures, ToolHooks } from "@opencode/plugin/effect/tool"
import type { ModelHookOptions } from "@opencode/plugin/effect/registration"
import type { PermissionHooks } from "@opencode/plugin/effect/permission"
import { Context, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { State } from "../state.js"

export interface Domains {
  readonly aisdk: AISDKHooks
  readonly session: SessionHooks
  readonly permission: PermissionHooks
  readonly shell: ShellHooks
  readonly tool: ToolHooks
}

type NoFailures<Spec> = { readonly [Name in keyof Spec]: never }

// Failure channel for each hook event. Only tool execute.before may fail: a Tool.Error rejects the call before it runs.
interface Failures extends Record<keyof Domains, unknown> {
  readonly aisdk: NoFailures<AISDKHooks>
  readonly session: NoFailures<SessionHooks>
  readonly permission: NoFailures<PermissionHooks>
  readonly shell: NoFailures<ShellHooks>
  readonly tool: ToolFailures
}

type Callback<Event, Error> = (event: Event) => Effect.Effect<void, Error>
type Entry = {
  readonly callback: Function
  readonly options?: ModelHookOptions
  readonly sourceReviewer?: () => boolean
  readonly modelReviewer?: boolean
}

const reviewMarker = (event: PermissionHooks["evaluate"]) => event.review

/** Invocation-local, private callback identity; no public event marker can construct this receipt. */
export interface ModelReceipt {
  readonly valid: () => boolean
  readonly includes: (entry: object) => boolean
  readonly reason: string
}

const eventProviderID = (event: unknown) => {
  if (typeof event !== "object" || event === null || !("model" in event)) return undefined
  const model = event.model
  if (typeof model !== "object" || model === null || !("providerID" in model)) return undefined
  return typeof model.providerID === "string" ? model.providerID : undefined
}

export interface Interface {
  readonly has: <Domain extends keyof Domains>(
    domain: Domain,
    name: keyof Domains[Domain] & keyof Failures[Domain],
    providerID?: string,
  ) => Effect.Effect<boolean>
  readonly register: <Domain extends keyof Domains, Name extends keyof Domains[Domain] & keyof Failures[Domain]>(
    domain: Domain,
    name: Name,
    callback: Callback<Domains[Domain][Name], Failures[Domain][Name]>,
    options?: ModelHookOptions,
  ) => Effect.Effect<State.Registration, never, Scope.Scope>
  readonly trigger: <Domain extends keyof Domains, Name extends keyof Domains[Domain] & keyof Failures[Domain]>(
    domain: Domain,
    name: Name,
    event: Domains[Domain][Name],
  ) => Effect.Effect<Domains[Domain][Name], Failures[Domain][Name]>
  /** Core-only registration and invocation; not exposed through the public hook API. */
  readonly registerSourceReviewer: (
    callback: Callback<PermissionHooks["evaluate"], never>,
    current?: () => boolean,
    modelReviewer?: boolean,
  ) => Effect.Effect<State.Registration, never, Scope.Scope>
  readonly reviewSource: (
    event: PermissionHooks["evaluate"],
  ) => Effect.Effect<{ event: PermissionHooks["evaluate"]; valid: () => boolean }>
  readonly revision: () => number
  readonly reviewPermission: (
    event: PermissionHooks["evaluate"],
    sourceOnly?: boolean,
    approval?: ModelReceipt,
  ) => Effect.Effect<{ event: PermissionHooks["evaluate"]; valid: () => boolean; review?: ModelReceipt }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PluginHooks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const callbacks = new Map<string, Entry[]>()
    let revision = 0
    const key = (domain: keyof Domains, name: PropertyKey) => `${domain}.${String(name)}`

    const register = Effect.fn("PluginHooks.register")(function* <
      Domain extends keyof Domains,
      Name extends keyof Domains[Domain] & keyof Failures[Domain],
    >(
      domain: Domain,
      name: Name,
      callback: Callback<Domains[Domain][Name], Failures[Domain][Name]>,
      options?: ModelHookOptions,
      sourceReviewer?: () => boolean,
      modelReviewer?: boolean,
    ) {
      const scope = yield* Scope.Scope
      const id = key(domain, name)
      let active = true
      const entry = { callback, options, sourceReviewer, modelReviewer }
      callbacks.set(id, [...(callbacks.get(id) ?? []), entry])
      revision++
      const dispose = Effect.sync(() => {
        if (!active) return
        active = false
        revision++
        const next = (callbacks.get(id) ?? []).filter((item) => item !== entry)
        if (next.length === 0) callbacks.delete(id)
        else callbacks.set(id, next)
      })
      yield* Scope.addFinalizer(scope, dispose)
      return { dispose }
    })

    const trigger: Interface["trigger"] = Effect.fnUntraced(function* (domain, name, event) {
      for (const entry of callbacks.get(key(domain, name)) ?? []) {
        if (entry.options?.providerID !== undefined && entry.options.providerID !== eventProviderID(event)) continue
        const result: Effect.Effect<void, Failures[typeof domain][typeof name]> = entry.callback(event)
        yield* result
      }
      return event
    })

    const has: Interface["has"] = (domain, name, providerID) =>
      Effect.sync(() =>
        (callbacks.get(key(domain, name)) ?? []).some(
          (entry) => entry.options?.providerID === undefined || entry.options.providerID === providerID,
        ),
      )

    const registerSourceReviewer: Interface["registerSourceReviewer"] = (callback, current = () => true, modelReviewer = false) =>
      register("permission", "evaluate", callback, undefined, current, modelReviewer)
    const reviewPermission: Interface["reviewPermission"] = Effect.fnUntraced(function* (event, sourceOnly = false, approval) {
      const selected = (callbacks.get(key("permission", "evaluate")) ?? []).filter(
        (entry) => !sourceOnly || entry.sourceReviewer?.(),
      )
      const models: Entry[] = []
      let hardDenied = event.effect === "deny"
      let reason = ""
      const initial = JSON.stringify([event.sessionID, event.agent, event.action, event.resources, event.metadata, event.source])
      for (const entry of selected) {
        delete event.review
        if (approval?.includes(entry) && approval.valid()) continue
        const prior = event.effect
        yield* entry.callback(event) as Effect.Effect<void>
        const marker = reviewMarker(event)
        const unchanged = initial === JSON.stringify([event.sessionID, event.agent, event.action, event.resources, event.metadata, event.source])
        if (event.effect === "deny") {
          if (!hardDenied && prior !== "deny" && entry.modelReviewer && entry.sourceReviewer?.() && unchanged && marker?.kind === "model-refusal") {
            models.push(entry)
            reason = marker.reason
            event.effect = prior
          } else hardDenied = true
        }
        if (hardDenied) event.effect = "deny"
      }
      delete event.review
      if (models.length > 0) event.effect = "deny"
      const valid = () => selected.length > 0 && selected.every(
        (entry) => (callbacks.get(key("permission", "evaluate")) ?? []).includes(entry) && (!entry.sourceReviewer || entry.sourceReviewer()),
      )
      return {
        event,
        valid,
        ...(!hardDenied && models.length > 0 ? { review: {
          valid: () => valid() && models.every((entry) => entry.sourceReviewer?.()),
          includes: (entry: object) => models.some((model) => model === entry),
          reason,
        } } : {}),
      }
    })
    const reviewSource: Interface["reviewSource"] = Effect.fnUntraced(function* (event) {
      const selected = (callbacks.get(key("permission", "evaluate")) ?? []).filter((entry) => entry.sourceReviewer?.())
      let denied = false
      for (const entry of selected) {
        yield* entry.callback(event) as Effect.Effect<void>
        denied ||= event.effect === "deny"
        if (denied) event.effect = "deny"
      }
      // Invocation-local receipt: the exact registrations must still be alive after every await.
      return {
        event,
        valid: () =>
          selected.length > 0 &&
          selected.every(
            (entry) => entry.sourceReviewer?.() && (callbacks.get(key("permission", "evaluate")) ?? []).includes(entry),
          ),
      }
    })
    return Service.of({
      has,
      register: (domain, name, callback, options) => register(domain, name, callback, options),
      trigger,
      registerSourceReviewer,
      reviewSource,
      reviewPermission,
      revision: () => revision,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
