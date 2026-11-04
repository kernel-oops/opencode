import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { SessionAffinity } from "@opencode/core/session/affinity"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionMessage } from "@opencode/core/session/message"

const id = (value: string) => SessionSchema.ID.make(`ses_${value}`)
const fork = (source: string) => ({
  fork: { sessionID: id(source), boundary: { type: "before" as const, messageID: SessionMessage.ID.create() } },
})
type Lineage = Pick<SessionSchema.Info, "parentID" | "fork">

describe("SessionAffinity", () => {
  const cases: { name: string; rows: Record<string, Lineage>; expected: string; loads: number }[] = [
    { name: "missing initial session", rows: {}, expected: "start", loads: 1 },
    { name: "standalone root", rows: { start: {} }, expected: "start", loads: 1 },
    { name: "direct child", rows: { start: { parentID: id("root") }, root: {} }, expected: "root", loads: 2 },
    {
      name: "nested child",
      rows: { start: { parentID: id("middle") }, middle: { parentID: id("root") }, root: {} },
      expected: "root",
      loads: 3,
    },
    {
      name: "fork of fork",
      rows: { start: fork("middle"), middle: fork("root"), root: {} },
      expected: "root",
      loads: 3,
    },
    {
      name: "mixed lineage",
      rows: { start: { parentID: id("middle") }, middle: fork("root"), root: {} },
      expected: "root",
      loads: 3,
    },
    {
      name: "parent takes precedence",
      rows: { start: { parentID: id("root"), ...fork("other") }, root: {}, other: {} },
      expected: "root",
      loads: 2,
    },
    { name: "missing direct parent", rows: { start: { parentID: id("missing") } }, expected: "missing", loads: 2 },
    {
      name: "missing ancestor",
      rows: { start: fork("middle"), middle: { parentID: id("missing") } },
      expected: "missing",
      loads: 3,
    },
    { name: "self loop", rows: { start: { parentID: id("start") } }, expected: "start", loads: 1 },
    {
      name: "two-node cycle",
      rows: { start: { parentID: id("middle") }, middle: { parentID: id("start") } },
      expected: "start",
      loads: 2,
    },
    {
      name: "cycle beyond requesting session",
      rows: { start: fork("a"), a: { parentID: id("b") }, b: fork("a") },
      expected: "start",
      loads: 3,
    },
  ]
  for (const scenario of cases) {
    test(scenario.name, async () => {
      const loaded: SessionSchema.ID[] = []
      const result = await Effect.runPromise(
        SessionAffinity.get(id("start"), (key) => {
          loaded.push(key)
          return Effect.succeed(scenario.rows[key.slice(4)])
        }),
      )
      expect(result).toBe(id(scenario.expected))
      expect(loaded).toHaveLength(scenario.loads)
    })
  }

  for (const length of [255, 256, 257]) {
    test(`bounds traversal for ${length} sessions`, async () => {
      let loads = 0
      const result = await Effect.runPromise(
        SessionAffinity.get(id("0"), (key) => {
          loads++
          const index = Number(key.slice(4))
          return Effect.succeed(index + 1 < length ? { parentID: id(String(index + 1)) } : {})
        }),
      )
      expect(loads).toBe(Math.min(length, 256))
      expect(result).toBe(id(length > 256 ? "0" : String(length - 1)))
    })
  }

  test("does not swallow loader defects or interruption", async () => {
    for (const load of [() => Effect.die(new Error("storage defect")), () => Effect.interrupt]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(SessionAffinity.get(id("start"), load)))).toBe(true)
    }
  })
})
