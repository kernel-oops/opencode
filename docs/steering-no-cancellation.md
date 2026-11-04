# Steering without automatic cancellation

Automatic generation cancellation on incoming input is deliberately disabled.
This is an unconditional runtime safeguard, not a model, caller or project
configuration option. The generation steering gate never invalidates and never
signals a change. Its serialised dispatch guard and scoped listener cleanup
remain in place, as do the inbox admission and owner-notification mutexes.

User and synthetic steers normally remain durable pending input. They are promoted once
at the ordinary step boundary, in the existing control and enqueue order.
The exact-session GPT-6 WebSocket opt-in described in `packages/core/README.md`
may instead deliver plain-text user corrections through native `response.steer`,
after committing them to history. That protocol preserves the parent's work and
does not enable client pre-emption, recovery fences or private deadlines.
Queued input retains its idle-boundary behaviour. A correction admitted during
request preparation or provider retry backoff does not rebuild the prepared
request or cancel the physical attempt. Overflow compaction recovery remains
within the existing logical step; input arriving during it is promoted at the
next ordinary step boundary, not during the recovery attempt.

The current generation can therefore finish in its old direction. Tools already
owned, and tool calls subsequently emitted by that generation, may execute
normally before the correction is delivered. Use explicit user interruption to
stop active work. Explicit interruption, shutdown, transport timeouts and
provider failure/retry handling retain their existing cancellation paths.

No native `response.interrupt` protocol is implemented by this change. No
provider request flags, capability probes or silent cancellation fallback are
introduced. The existing public `Step.Interrupted` schema and projection/client
surfaces remain compiled for history and contract consistency; their presence
does not re-enable automatic steering. A future release must still pair its
server with matching client artefacts. This safeguard alone is not proof of
wire compatibility with an older binary.

The delegated effort guard and owner-notification fix from the source base are
preserved. This change does not repair the separate creator ASK-approval clamp
or grant deployment, permission changes or approval automation.

Regression coverage exercises blocked production Session runners and the real
HTTP prompt leaf with fake local generation streams. It checks that admission
leaves the original stream running, the correction appears once in the next
boundary request, no steering-interruption event is recorded, and late tool
dispatch and explicit interruption retain their normal behaviour. The former
positive automatic-cancellation fixtures now assert these boundary semantics;
no suites are skipped to obtain a passing result.
