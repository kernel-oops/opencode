import { expect, test } from "bun:test"
import { isOpenCodeEvent, OpenCodeEvent, type OpenCodeEventEncoded } from "../src/groups/event.js"
import { EventManifest } from "@opencode/schema/event-manifest"
import { SessionMessage } from "@opencode/schema/session-message"
import { Option, Schema } from "effect"

type JsonShape<Value> = Value extends string | number | boolean | null
  ? Value
  : Value extends undefined
    ? never
    : Value extends ReadonlyArray<infer Item>
      ? ReadonlyArray<JsonShape<Item>>
      : Value extends object
        ? {
            readonly [Key in keyof Value as undefined extends Value[Key] ? never : Key]: JsonShape<Value[Key]>
          } & {
            readonly [Key in keyof Value as undefined extends Value[Key] ? Key : never]?: JsonShape<
              Exclude<Value[Key], undefined>
            >
          }
        : Value

// JSON.stringify omits undefined object properties, so normalize them before
// requiring every runtime event shape to fit its encoded wire contract.
const wireReady: [JsonShape<OpenCodeEvent>] extends [JsonShape<OpenCodeEventEncoded>] ? true : false = true

test("classifies public events by type", () => {
  expect(isOpenCodeEvent({ type: "server.connected" })).toBe(true)
  expect(isOpenCodeEvent({ type: "mcp.status.changed" })).toBe(true)
  expect(isOpenCodeEvent({ type: "mcp.resources.changed" })).toBe(true)
  expect(isOpenCodeEvent({ type: "mcp.tools.changed" })).toBe(false)
  expect(isOpenCodeEvent({ type: "acme.updated" })).toBe(false)
})

test("keeps public event runtime values within the encoded contract", () => {
  expect(wireReady).toBe(true)
})

test("steering terminals require matching event and assistant contracts", () => {
  const terminal = {
    id: "evt_contract", created: 0, type: "session.step.interrupted",
    durable: { aggregateID: "ses_contract", seq: 0, version: 1 },
    data: { sessionID: "ses_contract", assistantMessageID: "msg_contract", reason: "steer" },
  }
  expect(Schema.decodeUnknownSync(OpenCodeEvent)(terminal)).toMatchObject(terminal)
  // The pre-steering closed surface cannot decode the newly added event.
  const previousEvents = Schema.Union(EventManifest.ServerDefinitions.filter((event) => event.type !== "session.step.interrupted"))
  expect(Option.isNone(Schema.decodeUnknownOption(previousEvents)(terminal))).toBe(true)
  const message = {
    id: "msg_contract", type: "assistant", agent: "build", model: { id: "fixture", providerID: "fixture" },
    content: [], interruption: "steer", time: { created: 0, completed: 1 },
  }
  expect(Schema.decodeUnknownSync(SessionMessage.Assistant)(message)).toMatchObject({ interruption: "steer" })
  const { interruption, ...previousFields } = SessionMessage.Assistant.fields
  expect(interruption).toBeDefined()
  expect(Schema.decodeUnknownSync(Schema.Struct(previousFields))(message)).not.toHaveProperty("interruption")
})
