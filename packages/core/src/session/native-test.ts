export * as SessionNativeTest from "./native-test.js"

import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionNativeTest as Contract } from "@opencode/schema/session-native-test"
import { ModelResolver } from "../model-resolver.js"
import type { SessionSchema } from "./schema.js"

export type Settings = Contract.Settings
export type Reason = Contract.Reason
export type Fact = Omit<Contract.Record, "seq" | "at" | "execution" | "exchange">

/** Bounded metadata-only lane diagnostics. No progress tracking or steering deadlines. */
export const RING_SIZE = 256

interface Snapshot {
  readonly id: number
  readonly generation: number
  readonly settings: Settings
  transport?: "http" | "websocket"
  reason?: Reason
}

interface Lane {
  requested: Settings
  generation: number
  latest?: Snapshot
  records: Array<Contract.Record>
  seq: number
  dropped: number
  exchange: number
}

export interface View {
  readonly requested: Settings
  readonly effective: Settings
  readonly pending: boolean
  readonly execution?: Contract.Execution
  readonly diagnostics: Contract.Status["diagnostics"]
}

/**
 * Process-local registry for the exact-session native test lane. It is not a settings store: nothing
 * is persisted, inherited, copied to forks/children/imports or restored after a restart.
 */
export interface Interface {
  readonly serverRun: string
  /** Records the requested settings for future executions. At most one session may hold a non-default lane. */
  readonly request: (sessionID: SessionSchema.ID, settings: Settings) => Effect.Effect<void, Contract.LaneOccupiedError>
  /** Snapshots the requested settings at every execution-start boundary; immutable for the whole busy period. */
  readonly start: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly finish: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** The active execution's snapshot, or the off settings. Never the pending request. */
  readonly policy: (sessionID: SessionSchema.ID) => Settings
  /** Policy generation of the active execution; a change retires the session's previous channel. */
  readonly generation: (sessionID: SessionSchema.ID) => number
  readonly resolved: (sessionID: SessionSchema.ID, transport: "http" | "websocket", reason: Reason) => void
  /** Non-blocking, bounded metadata observation; a no-op unless debug is on. */
  readonly observe: (sessionID: SessionSchema.ID, fact: Fact) => void
  readonly inspect: (sessionID: SessionSchema.ID) => View
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionNativeTest") {}

const isOff = (settings: Settings) => settings.nativeSteer === false && settings.debug === false
const same = (left: Settings, right: Settings) => left.nativeSteer === right.nativeSteer && left.debug === right.debug

export const make = (now: () => number = Date.now): Interface => {
  // Every active execution's snapshot, including default-off ones; bounded by active executions.
  const executions = new Map<SessionSchema.ID, Snapshot>()
  // Lanes with requests or retained diagnostics. Idle off lanes are pruned when another lane is created,
  // so retained history stays bounded by the single test lane plus lanes of active executions.
  const lanes = new Map<SessionSchema.ID, Lane>()
  // Process-wide counters keep generations and execution IDs unique across sessions.
  let generations = 0
  let ids = 0

  const append = (lane: Lane, fact: Fact, execution: number) => {
    if (lane.records.length >= RING_SIZE) {
      lane.records.shift()
      lane.dropped++
    }
    lane.records.push({
      ...fact,
      seq: ++lane.seq,
      at: Math.max(0, Math.floor(now())),
      execution,
      exchange: lane.exchange,
    })
  }

  const record = (sessionID: SessionSchema.ID, fact: Fact) => {
    const current = executions.get(sessionID)
    const lane = lanes.get(sessionID)
    if (!current || !lane || current.settings.debug !== "metadata") return
    if (fact.kind === "send" || fact.kind === "adopt") lane.exchange++
    append(lane, fact, current.id)
  }

  const occupied = (sessionID: SessionSchema.ID) =>
    Array.from(lanes).some(([id, other]) => id !== sessionID && !isOff(other.requested)) ||
    Array.from(executions).some(([id, snapshot]) => id !== sessionID && !isOff(snapshot.settings))

  return {
    serverRun: randomUUID(),
    request: (sessionID, settings) =>
      Effect.suspend(() => {
        const lane = lanes.get(sessionID)
        if (lane && same(lane.requested, settings)) return Effect.void
        // Without a lane, any active execution is off: an off request changes nothing.
        if (!lane && isOff(settings)) return Effect.void
        if (!isOff(settings) && occupied(sessionID))
          return Effect.fail(new Contract.LaneOccupiedError({ message: "Another session already holds the native test lane" }))
        if (!lane)
          // Bound retained history: forget other idle, off lanes before creating a new one.
          for (const [id, other] of lanes)
            if (id !== sessionID && isOff(other.requested) && !executions.has(id)) lanes.delete(id)
        const next: Lane = lane ?? {
          requested: settings,
          generation: 0,
          // A lane created during a busy period starts from that execution's (off) snapshot.
          latest: executions.get(sessionID),
          records: [],
          seq: 0,
          dropped: 0,
          exchange: 0,
        }
        next.requested = settings
        next.generation = ++generations
        lanes.set(sessionID, next)
        return Effect.void
      }),
    start: (sessionID) =>
      Effect.sync(() => {
        const lane = lanes.get(sessionID)
        const current = { id: ++ids, generation: lane?.generation ?? 0, settings: lane?.requested ?? Contract.off }
        executions.set(sessionID, current)
        if (!lane) return
        lane.latest = current
        record(sessionID, { kind: "execution-started" })
      }),
    finish: (sessionID) =>
      Effect.sync(() => {
        const finished = executions.get(sessionID)
        if (!finished) return
        record(sessionID, { kind: "execution-finished" })
        executions.delete(sessionID)
        const lane = lanes.get(sessionID)
        // An off lane whose last execution already ran off has nothing left to retire or report.
        if (lane && isOff(lane.requested) && isOff(finished.settings) && finished.generation === lane.generation)
          lanes.delete(sessionID)
      }),
    policy: (sessionID) => executions.get(sessionID)?.settings ?? Contract.off,
    generation: (sessionID) => executions.get(sessionID)?.generation ?? 0,
    resolved: (sessionID, transport, reason) => {
      const current = executions.get(sessionID)
      if (!current) return
      current.transport = transport
      current.reason = reason
    },
    observe: record,
    inspect: (sessionID) => {
      const current = executions.get(sessionID)
      const lane = lanes.get(sessionID)
      const latest = current ?? lane?.latest
      const requested = lane?.requested ?? Contract.off
      return {
        requested,
        effective: latest?.settings ?? Contract.off,
        pending: current !== undefined && current.generation !== (lane?.generation ?? 0),
        ...(latest
          ? {
              execution: {
                id: latest.id,
                active: latest === current,
                settings: latest.settings,
                ...(latest.transport ? { transport: latest.transport } : {}),
                ...(latest.reason ? { reason: latest.reason } : {}),
              },
            }
          : {}),
        diagnostics: {
          records: lane?.records.slice() ?? [],
          dropped: lane?.dropped ?? 0,
          // Retained wire fields for older clients, not active bookkeeping.
          coalesced: 0,
          progress: 0,
        },
      }
    },
  }
}

export const layer = Layer.sync(Service, () => Service.of(make()))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

/**
 * Offline preflight for the session's current explicit or default selection: provider allowance and the
 * constructed route's protocol, without credentials, provider calls or package installation. The next
 * execution checks all of it again when it resolves its model.
 */
export const support = Effect.fn("SessionNativeTest.support")(function* (session: SessionSchema.Info) {
  const resolver = yield* ModelResolver.Service
  return yield* resolver.nativeSteerSupport(session.model)
})

/** Bounded metadata-only status. Never exposes provider settings, credentials, endpoints or payloads. */
export const status = Effect.fn("SessionNativeTest.status")(function* (registry: Interface, session: SessionSchema.Info) {
  const view = registry.inspect(session.id)
  const allowance = yield* support(session)
  return {
    sessionID: session.id,
    serverRun: registry.serverRun,
    ...view,
    supported: allowance === "allowed",
    reason: view.requested.nativeSteer === false ? ("not-requested" as const) : allowance,
    unresolvedFence: false,
  } satisfies Contract.Status
})

/** Requests settings for the session's next execution; an active execution keeps its snapshot. */
export const update = Effect.fn("SessionNativeTest.update")(function* (
  registry: Interface,
  session: SessionSchema.Info,
  settings: Settings,
) {
  if (settings.nativeSteer !== false) {
    const allowance = yield* support(session)
    if (allowance !== "allowed")
      return yield* new Contract.UnsupportedError({
        reason: allowance,
        message: "The session's selected provider does not permit the native test lane",
      })
  }
  yield* registry.request(session.id, settings)
  return yield* status(registry, session)
})
