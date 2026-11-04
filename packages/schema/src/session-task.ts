export * as SessionTask from "./session-task.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"

export const Background = Schema.Struct({
  sessionID: SessionID,
  agent: Schema.String,
  description: Schema.String,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
}).annotate({ identifier: "SessionTask.Background" })
export type Background = typeof Background.Type

export const Status = Schema.Struct({
  paused: Schema.Boolean.annotate({
    description: "Automatic subagent completion delivery is paused; completions are retained in the inbox.",
  }),
  active: Schema.Boolean.annotate({ description: "The Session has an execution owned by this process." }),
  background: Schema.Array(Background).annotate({
    description: "Process-local subagent jobs owned by this Session.",
  }),
}).annotate({ identifier: "SessionTask.Status" })
export type Status = typeof Status.Type

export const StopResponseResult = Schema.Struct({
  interrupted: Schema.Boolean,
  paused: Schema.Boolean,
}).annotate({ identifier: "SessionTask.StopResponseResult" })
export type StopResponseResult = typeof StopResponseResult.Type

export const ResumeResult = Schema.Struct({
  resumed: Schema.Boolean.annotate({ description: "Whether a pause was released." }),
}).annotate({ identifier: "SessionTask.ResumeResult" })
export type ResumeResult = typeof ResumeResult.Type

export const StopAllResult = Schema.Struct({
  interrupted: Schema.Boolean,
  cancelled: Schema.Array(SessionID).annotate({
    description: "Child Sessions whose jobs were cancelled and suppressed.",
  }),
}).annotate({ identifier: "SessionTask.StopAllResult" })
export type StopAllResult = typeof StopAllResult.Type

export const CancelOneResult = Schema.Struct({
  owned: Schema.Boolean.annotate({
    description: "Whether the given sessionID was an owned background subagent of this Session.",
  }),
  cancelled: Schema.Array(SessionID).annotate({
    description: "Sessions whose jobs were cancelled and suppressed, descendants first.",
  }),
}).annotate({ identifier: "SessionTask.CancelOneResult" })
export type CancelOneResult = typeof CancelOneResult.Type
