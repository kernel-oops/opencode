# @opencode/core

Core runtime services for OpenCode.

## Permission review consistency

Awaited permission reviews bind immutable delegation and origin identities, the
complete proven creator ancestry, current identity/placement/permissions/model and
revert boundaries, fresh filesystem/repository authority, ordered configured and
saved rules, and the current authenticated reviewer registrations. Title, cost,
token counters, updated/viewed/idle times, outcome and editable metadata are not
authority and do not invalidate an otherwise unchanged review.

USER admission writes a private KV revision in the same transaction as its inbox
insert, independently of optional bus-payload retention. The proven root's revision,
pending USER input and visible USER boundaries, together with persisted instruction
state/entries throughout the ancestry, fence stale automatic approval. A pending
root USER blocks approval even when it predates the review; queue, steer and
admit-only delivery do not bypass the fence. USER denotes conservative freshness,
not trusted authorship: immutable provenance still prevents native owner briefs or
editable metadata from becoming human authority. Repeated admissions of the same
inbox ID do not advance the revision, and delivery/cancellation do not erase it.

Decision diagnostics record request-correlated comparison booleans, effects and
receipt validity, never private authority snapshots or instruction content.
Current DENY and closed ownership remain decisive. A changed context yields ASK;
core does not interpret a new STOP, automatically re-review, replay a command or
reply to an existing permission prompt.

## Delegated reasoning effort

An open native delegated owner, child or fork may select a configured reasoning-effort
variant of its current catalogue model. The primary owner must retain its immutable
reserved provider and model; specialists retain their own current model. Unset child
models use the normal Location catalogue default and resolver fallback, not an agent
model override. Clearing a variant is allowed only when its effective definition differs
solely in supported reasoning-effort leaves.

The core API, fresh-state event projection and native ownership reconciliation use the
same configured-definition comparison. It permits changed effort values `none`,
`minimal`, `low`, `medium` and `high`, not new extreme or unknown values. Variant labels
are not authority: every other effective setting, header and body field must remain
equal. Validation does not load provider packages or resolve credentials; it establishes
unchanged configuration inputs, not a promise about arbitrary third-party provider code.

Effort selection does not change identity, placement, permissions, immutable provenance
or delegation scope, and does not prompt, relaunch, wake or interrupt a Session. Closed
ownership remains fenced. Native status and close reconcile a permitted effort selection
without weakening the exact initial reserved model check or restarting development.

Native terminal observers serialize notification bookkeeping on the owner's inbox key.
Synthetic admission independently takes the distinct creator's inbox key. This preserves
the single durable winning notification and avoids re-entering the creator's mutex.
Creators cannot themselves have native delegated provenance, so native notification
edges run from independent owners to their non-delegated creator, never back again.

## Steering and queued input

User and synthetic input use `delivery: "steer"` by default. Ordinary steering
waits for the current step boundary; it never pre-empts the client stream or tools.

`delivery: "queue"` waits for the idle boundary. Controls such as movement and
compaction retain their existing safe-boundary behaviour.

Native OpenAI steering is **off by default**. An operator may allow it with
`providers.openai.settings.nativeSteer: "response.steer"`; an exact session must
also opt in with `PUT /api/experimental/session/:sessionID/native-test` and
`{"nativeSteer":"response.steer","debug":false}`. This process-local opt-in is not
inherited or restored after restart. It selects Responses WebSockets for GPT-6
only. Set `nativeSteer` to `false` through the same endpoint to opt out.

Plain-text corrections are committed to normal history before sending. Accepted
steering follows the automatic successor, or supplies required tool results on
the same connection without repeating the steer. A rejection or disconnect uses
normal history on the next request: there are no recovery fences or private
steering deadlines. Already-started tools are not cancelled.

If a steer gets neither an acknowledgement nor a successor, the parent terminal
waits for the ordinary stream idle timeout (30 minutes by default). With idle
timeouts disabled, this can wait indefinitely; there is no separate steering
watchdog. The same limitation applies if admission fails after the driver records
the steer but before the frame is sent.

`resume: false` (or a hook's `wake: false`) still prevents starting an idle
runner, but an already-active generation observes durably admitted steering
input. Held or digest-buffered input is not admitted yet. Callback defaults are
unchanged.

Only a superseded retry has an informational `session.step.interrupted` terminal event
with reason `steer`, and its assistant message has `interruption: "steer"`. It is
not a provider error or a completed child-agent result. Partial readable content
and settled tool results survive replay; incomplete opaque reasoning and response
continuation state are not used as proof for the rebuilt request. Native steering
does not interrupt or discard the parent's work; its normal terminal is retained.
Missing provider usage remains unknown rather than an observed zero. Historical
native events and diagnostic fields remain decodable for compatibility; legacy
fence/progress fields in the native-test status are constant false/zero.

### Stale permission reviews

Permission review consistency is separate from a genuine request for human approval.
Pending root USER input or changed authority, policy, request binding or required
source ALLOW receipt invalidates the guarded operation. `Permission.assert` fails
with the normal typed `ReviewStaleError` before creating an approval request;
`Permission.ask` returns the existing public `deny` effect without pending state.
Current configured, immutable-source and plugin denials still take precedence.
An unchanged genuine ASK retains its ordinary human approval and decline behaviour.

The tool error asks the model to process new input and reassess before a fresh
operation. It does not replay the old invocation, consume input, interrupt the
generation or claim that earlier operations in a multi-operation tool had no
effects. Other owned tools settle normally; steer and queue retain their existing
safe-boundary and idle-boundary delivery semantics. Explicit approval replies
cannot authorise a stale review, including siblings considered by bulk `always`.
The two-snapshot fence is not a global atomic stop protocol.

### Server/client release pairing

This adds a first-class public event and assistant field. Deploy it with matching
server, schema, generated client and UI versions: an older closed event decoder
rejects `session.step.interrupted`, and older assistant decoding can discard the
`interruption` marker. Ignoring unknown JSON events does not establish correct
older-client projection or result-selection behaviour. Existing event versions
are unchanged; the new event owns its first durable version. This source change
does not authorise deploying a mixed-version runtime or updating installed clients.
