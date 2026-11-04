export * as TaskTool from "./task.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { SessionSchema } from "../../session/schema.js"
import { SessionTaskControl } from "../../session/task-control.js"

// A field-less Schema.Struct({}) serialises without a top-level "type", which providers reject.
const StatusInput = Schema.Struct({
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Optional: report only this background subagent instead of all of them.",
  }),
})

const CancelInput = Schema.Struct({
  sessionID: SessionSchema.ID.annotate({
    description:
      "The childSessionID of a background subagent you launched (from the subagent tool's background result, or from task_status).",
  }),
})

export const Plugin = {
  id: "opencode.tool.task",
  effect: Effect.fn("TaskTool.Plugin")(function* (ctx: Context) {
    const tasks = yield* SessionTaskControl.Service

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "task_status",
          options: { codemode: false },
          description: [
            "Lists the background subagents you launched with the subagent tool's background=true option that are still tracked in this process.",
            "For each one, shows its sessionID, agent, description, and job status (running, completed, error, cancelled).",
            "You are notified automatically when a background subagent finishes; use this tool only if you need to check the current state on demand, not as a substitute for those notifications.",
            "DO NOT sleep, poll, or call this in a loop to wait on a background subagent — wait for its completion notification instead.",
          ].join("\n"),
          input: StatusInput,
          output: SessionTaskControl.Status,
          execute: (input, context) =>
            tasks.status(context.sessionID).pipe(
              Effect.map((full) => {
                const status =
                  input.sessionID === undefined
                    ? full
                    : { ...full, background: full.background.filter((task) => task.sessionID === input.sessionID) }
                return {
                  output: status,
                  content:
                    status.background.length === 0
                      ? input.sessionID === undefined
                        ? "No background subagents are tracked for this session."
                        : `No background subagent ${input.sessionID} is tracked for this session.`
                      : status.background
                          .map((task) => `- ${task.sessionID} (${task.agent}): ${task.status} — ${task.description}`)
                          .join("\n"),
                }
              }),
              Effect.mapError((error) => new ToolFailure({ message: "Unable to read task status", error })),
            ),
        })
        editor.add({
          name: "task_cancel",
          options: { codemode: false },
          description: [
            "Cancels one of your own background subagents by its sessionID, interrupting it and cancelling its own background descendants first.",
            "Only subagents you launched from this session can be cancelled; a sessionID that is not one of yours, or is not currently tracked, is refused.",
            "The subagent's notification is suppressed: you will not be notified when it would otherwise have completed.",
          ].join("\n"),
          input: CancelInput,
          output: SessionTaskControl.CancelOneResult,
          execute: (input, context) =>
            tasks.cancelOne(context.sessionID, input.sessionID).pipe(
              Effect.mapError((error) => new ToolFailure({ message: "Unable to cancel task", error })),
              Effect.flatMap((result) =>
                result.owned
                  ? Effect.succeed({
                      output: result,
                      content:
                        result.cancelled.length === 0
                          ? `Subagent ${input.sessionID} was not running; nothing to cancel.`
                          : `Cancelled: ${result.cancelled.join(", ")}.`,
                    })
                  : new ToolFailure({
                      message: `Session ${input.sessionID} is not a background subagent owned by this session.`,
                    }),
              ),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}
