import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "../src/event.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionID } from "../src/session-id.js"

test("native settlement distinguishes natural completion and preserves historical outcomes", () => {
  for (const outcome of ["verified", "completed", "user-recovery"] as const) {
    const data = { sessionID: SessionID.create(), attemptID: Event.ID.create(), outcome }
    expect(Schema.decodeUnknownSync(SessionEvent.NativeControl.Settled.data)(data)).toEqual(data)
    expect(Schema.encodeSync(SessionEvent.NativeControl.Settled.data)(data)).toEqual(data)
  }
  expect(() => Schema.decodeUnknownSync(SessionEvent.NativeControl.Settled.data)({
    sessionID: SessionID.create(), attemptID: Event.ID.create(), outcome: "requested",
  })).toThrow()
})
