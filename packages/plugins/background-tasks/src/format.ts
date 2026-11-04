/** Display-only task formatting, independent of the built-in terminal contexts. */
export const titlecase = (value: string) => value.replace(/\b\w/g, (character) => character.toUpperCase())
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const taskStatusLabel = (status: string) =>
  ({ running: "Running", completed: "Completed", error: "Failed", cancelled: "Cancelled" })[status] ?? status
