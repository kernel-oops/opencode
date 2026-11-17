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
      "The sessionID of a descendant subagent to cancel, including an idle, completed or untracked child or grandchild.",
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
            "Lists the subagents you launched with the subagent tool that are still tracked in this process.",
            "For each one, shows its sessionID, agent, description, and job status (running, completed, error, cancelled).",
            "Also lists running shells owned by this session and its persisted descendants, even when no job is tracked.",
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
                    : {
                        ...full,
                        background: full.background.filter((task) => task.sessionID === input.sessionID),
                        shells: full.shells.filter((shell) => shell.sessionID === input.sessionID),
                      }
                return {
                  output: status,
                  content: [
                    status.background.length === 0
                      ? input.sessionID === undefined
                        ? "No background subagents are tracked for this session."
                        : `No background subagent ${input.sessionID} is tracked for this session.`
                      : status.background
                          .map((task) => `- ${task.sessionID} (${task.agent}): ${task.status} — ${task.description}`)
                          .join("\n"),
                    ...status.shells.map(
                      (shell) => `- Shell ${shell.id} (${shell.sessionID}): running — ${shell.command}`,
                    ),
                  ].join("\n"),
                }
              }),
              Effect.mapError((error) => new ToolFailure({ message: "Unable to read task status", error })),
            ),
        })
        editor.add({
          name: "task_cancel",
          options: { codemode: false },
          description: [
            "Cancels a descendant subagent by its sessionID, interrupting it and cancelling its descendants first.",
            "Persisted descendants are owned even when idle, completed or no longer tracked after a restart. Sessions outside your descendant tree are refused.",
            "Also stops running shells belonging to that descendant tree, keeping their retained output and logs.",
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
                        result.cancelled.length === 0 && result.stoppedShells.length === 0
                          ? `Subagent ${input.sessionID} was not running; nothing to cancel.`
                          : [
                              ...(result.cancelled.length ? [`Cancelled: ${result.cancelled.join(", ")}.`] : []),
                              ...(result.stoppedShells.length
                                ? [`Stopped shells (output retained): ${result.stoppedShells.join(", ")}.`]
                                : []),
                            ].join("\n"),
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
