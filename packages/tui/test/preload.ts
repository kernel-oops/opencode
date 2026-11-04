import { afterEach } from "bun:test"
import { NativeError, NativeStatus, OptimizedBuffer } from "@opentui/core"
import { unexpectedRequests } from "./fixture/tui-client"

// Workaround: OpenTUI's test renderer can read a frame while the native writer is still flushing
// output, which throws OutputBusy until the event loop runs. Frame reads poll, so fall back to the
// last frame read from the buffer. Remove once captureCharFrame waits for output idle upstream.
const frames = new WeakMap<OptimizedBuffer, Uint8Array>()
const getRealCharBytes = OptimizedBuffer.prototype.getRealCharBytes
OptimizedBuffer.prototype.getRealCharBytes = function (addLineBreaks) {
  try {
    const bytes = getRealCharBytes.call(this, addLineBreaks)
    frames.set(this, bytes)
    return bytes
  } catch (error) {
    if (!(error instanceof NativeError) || error.status !== NativeStatus.OutputBusy) throw error
    return frames.get(this) ?? new Uint8Array()
  }
}

// A test's own server records unexpected requests rather than throwing (see fixture/tui-client.ts); fail that test here.
afterEach(() => {
  const unexpected = unexpectedRequests.splice(0)
  if (unexpected.length) throw new Error(unexpected.map((error) => error.message).join("\n"))
})

// Fail fast if leaked apps pile up again: on 2026-10-30 a cascade grew this suite to 45 GiB and OOM-killed the host.
const maxRss = Number(process.env.OPENCODE_TUI_TEST_MAX_RSS_MB ?? 4096) * 2 ** 20
setInterval(() => {
  const rss = process.memoryUsage.rss()
  if (rss <= maxRss) return
  process.stderr.write(
    `tui tests: RSS ${Math.round(rss / 2 ** 20)} MiB exceeds OPENCODE_TUI_TEST_MAX_RSS_MB; aborting\n`,
  )
  process.exit(1)
}, 1000).unref()
