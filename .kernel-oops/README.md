# Fork release identity

`.kernel-oops/upstream-release` records the upstream source baseline, not the fork build number.
Keep upstream package versions and `CHANGELOG.md` unchanged when preparing fork releases.
The release controller supplies `OPENCODE_VERSION` and, where needed, `OPENCODE_CHANNEL`
to the existing CLI build script. `packages/script/src/index.ts` already reads these values;
no package manifest, lockfile or changelog rewrite is needed to stamp an artefact.

The B12 stack is `b12-fixes` → `b12-hooks` → `b12-features`, based on v2.2.5.
Only the fixes and hooks series are candidates for public publication; the transitional
features series and this directory are private. No publication or deployment is implied.

The background-tasks plugin is maintained separately in `kernel-oops/opencode-background-tasks`.
Its source is no longer part of the workspace. Existing TUI-only helper callers stay local
until the task presentation itself is moved out in Phase 4.

## Upstream invariants and tag integration

Before any release build, run `.kernel-oops/check-release-invariants` from the checkout being built.
It fails if a test listed in `.kernel-oops/release-invariants` is missing or failing. Never delete or
narrow a listed test to make a merge pass; changing the list needs the release controller's
independent review.

Why: upstream #60498 (822594b9ae, in v2.2.5) stopped lowering reasoning to ordinary text. Our merge
of v2.2.5 into B11 (ade24051c6) resolved the conflicting hunk in `to-llm-message.ts` by keeping our
older fallback line, the B12 restack (69515426ba) copied that file verbatim, and B12–B14 shipped it.
Upstream's own tests kept passing because the fallback survived only for fork-only states (steer
interruption, native receipts) that they never construct. `git merge-base --is-ancestor <fix> HEAD`
proves nothing here: the fix commit was an ancestor throughout.

When integrating an upstream tag:

1. Merge the tag; never restore an older feature tree or check out whole files from a pre-merge branch.
2. Run `.kernel-oops/check-release-invariants --overlap OLD NEW` and review every listed upstream
   commit against our hunks in that file, including files that merged without conflict.
3. Where an upstream fix changes behaviour our patch also touches, adapt our patch to the upstream
   behaviour and add a fork-state test for it to `.kernel-oops/release-invariants`.
