export * as SessionTask from "./session-task.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { Shell } from "./shell.js"

export const BackgroundShell = Schema.Struct({
  id: Shell.ID,
  sessionID: SessionID,
  command: Schema.String,
}).annotate({ identifier: "SessionTask.BackgroundShell" })

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
  shells: Schema.Array(BackgroundShell).annotate({
    description:
      "Running shells belonging to this Session or its persisted descendants, including untracked subagents.",
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
  stoppedShells: Schema.Array(Shell.ID),
  cancelled: Schema.Array(SessionID).annotate({
    description:
      "Descendant Sessions whose running jobs were cancelled and suppressed or whose execution was interrupted.",
  }),
}).annotate({ identifier: "SessionTask.StopAllResult" })
export type StopAllResult = typeof StopAllResult.Type

export const CancelOneResult = Schema.Struct({
  stoppedShells: Schema.Array(Shell.ID),
  owned: Schema.Boolean.annotate({
    description: "Whether the given sessionID is a persisted descendant of this Session.",
  }),
  cancelled: Schema.Array(SessionID).annotate({
    description:
      "Sessions whose running jobs were cancelled and suppressed or whose execution was interrupted, descendants first.",
  }),
}).annotate({ identifier: "SessionTask.CancelOneResult" })
export type CancelOneResult = typeof CancelOneResult.Type
