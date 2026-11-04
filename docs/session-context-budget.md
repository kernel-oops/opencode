# Session estimated-context budget

`PATCH /api/session/:sessionID` accepts an optional, session-only policy:

```json
{ "contextBudget": { "target": 400000, "maximum": 480000 } }
```

The target and maximum are positive integers, with target strictly below maximum. Omitting the field leaves existing behaviour unchanged. Children and forks do not inherit it. Sending `null` removes it. Setting the policy explicitly, including the same values, is a maintenance action which re-arms admission; it never grants an oversized request an exception or changes permissions, model capabilities or delegation limits.

## Counter contract and uncertainty

The units are **estimated total tokens, including a 15% input-estimate margin**, not bytes and not an exact provider-token ceiling:

- `E` is the larger of the existing complete assembled-request estimate and `Token.estimate` of the final decoded outbound text JSON, plus the usage-backed reasoning allowance below. The latter runs after the HTTP-request or WebSocket-send hooks. The two representations are not added together.
- `I = ceil(E × 1.15)`, using the existing input-estimate margin.
- `R` is the finite positive maximum output tokens actually requested. On the outbound representation it must be recognisable as a supported output-limit field.
- `T = I + R`. Admission also requires `I` to fit the existing model safe-input ceiling (including its reply reserve), and `T` to fit the resolved model context window. A smaller or switched model never receives a larger ceiling because of this policy. The guard does not lower `R` to make admission succeed.

The complete representation includes instructions, summary text, messages, tool arguments/results and tool descriptions/schemas. It does not reuse provider-only usage anchors, which cannot account for changes to hooks or model identity. The estimator remains the existing characters-divided-by-four heuristic. English, code and Unicode tests verify the declared arithmetic and inclusion, **not tokenisation accuracy**. No same-model provider calibration or paid test has been performed. The 15% margin is not proven to cover dense code, all languages or arbitrary provider tokenisation.

The final HTTP/WS admission check reads the current session policy even if preparation began without one. An unbudgeted no-hook HTTP request keeps its original body/handler path and does not decode/count that body. Enabling a policy after preparation does not manufacture pre-hook reasoning provenance: an already-prepared request without the required evidence must fail closed.

Unknown limits or output reserves, unrepresentable values, media/file results, encrypted/native checkpoints, hosted tool expansion and opaque provider conversation references fail closed. Stateful/delta WebSocket frames carrying unrepresented previous-response context are blocked; fully represented HTTP requests and WebSocket creates use the same gate. Native steering is not submitted for budgeted requests because the provider-owned successor cannot be measured before submission. Its pending input remains in the ordinary durable inbox.

### Ordinary encrypted reasoning

OpenAI Responses normally replays encrypted reasoning. Its ciphertext length is not a semantic token count. A narrowly usage-backed replay allowance permits ordinary completed reasoning without disabling or stripping it:

- Before hooks, copy primitive evidence from successfully completed source assistants and completed reasoning parts. Require the selected provider, model **and variant**, assistant/response/item IDs, exact ciphertext and finite non-negative persisted output/reasoning usage with a positive total. Errors, interrupted/ambiguous native states, missing IDs/usage and incomplete reasoning are ineligible.
- Prepared reasoning must match that source under the expected provider-metadata namespace. Final ordinary reasoning items must match the prepared item ID and exact ciphertext. Unknown items, conflicting ciphertext, duplicate final items and late injection fail closed. The adapter's normal coalescing of several summary fragments for one reasoning item is allowed.
- In temporary counting views only, exclude validated ciphertext and add `G`: the **full persisted output plus reasoning usage once per represented source assistant**, not once per item. Persisted output excludes reasoning; raw provider `output_tokens` includes it. Visible text and JSON overhead still count, so this deliberately overcounts visible generation. Preserve any additional lexical overhead in the original JSON.

Thus `E = max(assembled text estimate, final wire text estimate) + G`. Actual request bytes, signatures, ciphertext and history are unchanged. The runner and existing compaction preparation both carry this request-local evidence; there is no new persistent reconstruction ledger. This is a usage-backed replay estimate, **not** a guarantee about the semantic size of arbitrary ciphertext. Unbound encrypted reasoning and encrypted compaction checkpoints remain blocked.

## Recovery and durable state

At or above the target, the runner attempts the existing eligible automatic compaction once, then reloads history and rebuilds the request. A target crossed only by a late wire hook returns a typed local recovery outcome to the same runner; it is not a provider retry. Summary requests, including their appended compaction instructions and any reminder, are subject to admission too. There is no oversized maintenance-call exemption and no automatic removal of protected input to get such a call through.

The attempted model/tool/agent binding is persisted before recovery starts. Failure, interruption and a protected or ineffective floor therefore remain latched across ordinary arrivals and process restarts. Falling below the target on a verified request, a changed binding or an explicit maintenance action can re-arm it. Being below the maximum is not the same as meeting the target: a request between them may proceed after its one recovery attempt, without repeatedly compacting the same floor.

If the rebuilt request is still oversized or cannot be measured, admission records `contextBudgetState.blocked` and returns the non-retryable `context.budget-blocked` outcome. The state includes the selected model, raw estimate, margin-adjusted input, requested output reserve and effective ceilings when those are known. The same blocked floor is reported once; ordinary arrivals do not start model execution again. Inputs already delivered remain durable history, and later inputs/callback receipts remain in the durable inbox. The guard does not cancel already-dispatched tools or jobs, replay their submissions, or erase their results. Explicit stops and the existing compaction/move controls remain available.

While blocked, a control-only runner boundary can settle a steered move behind retained receipts without promoting those receipts or starting a model call. It preserves control-to-control move boundaries, queued-input ordering, and the existing placement and delegation restrictions; retained items stay in their original durable rows.

Manual compaction may supply a safely sized existing hook result without another model call; if it needs a model, that request must fit too. An explicit policy update or model switch permits a fresh local check, not blind or timed retry. If safe maintenance cannot fit, leave the session blocked for an explicit recovery decision. Disabling the policy changes future admission only; it does not restore an earlier checkpoint or reset history.

This document describes isolated product implementation. It does not enable a policy for any particular session, switch DCP/KCP, authorise live compaction, or grant restart/deployment authority.
