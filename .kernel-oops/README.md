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
