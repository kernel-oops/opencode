#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_REPOSITORY="kernel-oops/opencode"
readonly UPSTREAM_REPOSITORY="anomalyco/opencode"
readonly UPSTREAM_URL="https://github.com/anomalyco/opencode.git"
readonly PUBLISH_URL="https://github.com/kernel-oops/opencode.git"
readonly AUTOMATION_BRANCH="dev"
readonly BASE_BRANCH="personal-runtime"
readonly GENERATED_BRANCH="release-sync"
readonly GENERATED_REF="refs/heads/release-sync"
readonly MARKER_FILE=".kernel-oops/upstream-release"
readonly WORKFLOW_FILE=".github/workflows/upstream-release-sync.yml"
readonly HELPER_FILE=".github/scripts/upstream-release-sync.sh"
readonly STATUS_CONTEXT="release-sync/verified"
readonly FAILURE_TITLE="[automation] Upstream release sync failed"
readonly BASE_REF="refs/remotes/release-sync/base"
readonly UPSTREAM_REF="refs/remotes/release-sync/upstream-tag"
readonly BUNDLE_BASE_REF="refs/release-sync/base"
readonly BUNDLE_UPSTREAM_REF="refs/release-sync/upstream"
readonly BUNDLE_CANDIDATE_REF="refs/release-sync/candidate"
readonly BUNDLE_HEAD_REF="refs/release-sync/head"

readonly PATCH_BRANCHES=(
  "feat/instance-idle-eviction"
  "fix/directory-sse-replacement"
  "fix/permission-ask-hook"
  "permission-review-foundation"
  "permission-model-reviewer"
  "reviewer-context-fix"
  "reviewer-stream-fix"
  "shell-classifier-fix"
  "review-pipeline-v21"
  "evaluator-contract-fix"
  "luna-policy-gate"
  "release-compat-v21"
  "audit-correlation-log"
  "exceptional-risk-policy"
  "permit-only-evaluator"
)
readonly PATCH_IDS=(
  "bfc7dc5221ddf03641a7859102b333454895dd73"
  "cd8d39747332305cee8f24437a24252ca6b63fec"
  "2d809744f702b22e522bded27be89f159bb6a007"
  "d5a64752b2cb925ad648334cd6fe7a7db05c644e"
  "62c7c05b62aef0b4ea2688114e8d2a348d5d1c12"
  "b3238c230f1aa12173a58af1c1b90e81ed8eb3c5"
  "4b5e8f1cbbb0a9382f4153ce50df98567d55f82b"
  "eaeee8050336276bddf64d8a98cd5b6def379a3c"
  "9b08e4d4e1ad8b496e09ff8c5ce1ccd60b46d118"
  "8e6ab9b0a308c9bb5b5153c7af8124b89e782531"
  "05b11db331352eaab7c178fc91af52a4114ebf5b"
  "cbe4834b37db0088970a21343e99f301f5f6494d"
  "2962ce77cc0e89955e2dc952f6f5bd941e56465c"
  "8d5352767402a5c6c1278eb0bc3f632462e9a1c9"
  "c300b3afd3a5e82dd4b1540db2e2301c95612613"
)
readonly PATCH_TIPS=(
  "11bf5729c6ac3b55ce4e5a3ba7f5a3ef890be8ac"
  "ae77d8aa248de63bfe63205f9a6472813ff5d9f4"
  "dd25dface43a03915fe49e706bcb4d0771d399e9"
  "eba08dbfe9997d0aed92260c924dfe99edd0eb7a"
  "73491a9cbbb9ba54a7b88b95f905efe76e14db4b"
  "48b090a66190d25a3eccdbd65d86060507d960a6"
  "03f9f95247d8dc118114d5d039b98c3e8257a868"
  "590ad2822dbd8a1eb517a2bbba9ea75ce48423de"
  "f91fd9d2cea117759266bc28fecb9eade8604fcb"
  "fa8ff68b0328497d88399b79a7ea7712dfb8ff70"
  "7c4ff70252edd64b036f0285e8cb64bbab76fd32"
  "9b674dafede57433c099c566675938bfc90f09f0"
  "f009e4a9e73e23daa98e410b0865cfbe95c5f357"
  "f4d5e64be105ccf3bb71f98ec1ca49719c3cd96c"
  "525a5f583c5a41c2ce511846e5a7418f9f9d40fa"
)
readonly REVIEWED_TESTS=(
  "packages/core/test/config/config.test.ts"
  "packages/core/test/effect/cross-spawn-spawner.test.ts"
  "packages/core/test/pty/activity.test.ts"
  "packages/opencode/test/effect/runtime-flags.test.ts"
  "packages/opencode/test/config/config.test.ts"
  "packages/opencode/test/permission/admission.test.ts"
  "packages/opencode/test/permission/advisory-gate.test.ts"
  "packages/opencode/test/permission/bash-evaluator.test.ts"
  "packages/opencode/test/permission/audit-correlation.test.ts"
  "packages/opencode/test/permission/exceptional-risk-policy.test.ts"
  "packages/opencode/test/permission/next.test.ts"
  "packages/opencode/test/permission/obvious-risk-policy.test.ts"
  "packages/opencode/test/permission/replay-oauth.test.ts"
  "packages/opencode/test/permission/reviewer-input.test.ts"
  "packages/opencode/test/permission/reviewer.test.ts"
  "packages/opencode/test/plugin/codex.test.ts"
  "packages/opencode/test/plugin/trigger.test.ts"
  "packages/opencode/test/project/instance.test.ts"
  "packages/opencode/test/question/question.test.ts"
  "packages/opencode/test/server/httpapi-event.test.ts"
  "packages/opencode/test/server/httpapi-instance-context.test.ts"
  "packages/opencode/test/server/httpapi-instance.test.ts"
  "packages/opencode/test/server/httpapi-sdk.test.ts"
  "packages/opencode/test/server/instance-eviction.test.ts"
  "packages/opencode/test/server/project-init-git.test.ts"
  "packages/opencode/test/session/prompt.test.ts"
  "packages/opencode/test/session/schema-decoding.test.ts"
  "packages/opencode/test/tool/registry.test.ts"
  "packages/opencode/test/tool/shell.test.ts"
)

summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY"
}

output() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}

die() {
  echo "release-sync: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_runtime_repository() {
  if [[ -n "${GITHUB_REPOSITORY:-}" && "$GITHUB_REPOSITORY" != "$EXPECTED_REPOSITORY" ]]; then
    die "refusing untrusted repository destination: $GITHUB_REPOSITORY"
  fi
  if [[ "${GITHUB_ACTIONS:-false}" == "true" ]]; then
    [[ "${GITHUB_REPOSITORY:-}" == "$EXPECTED_REPOSITORY" ]] || die "unexpected GitHub repository"
    [[ "${GITHUB_REF:-}" == "refs/heads/${AUTOMATION_BRANCH}" ]] || die "workflow must run from ${AUTOMATION_BRANCH}"
    local origin_url
    origin_url="$(git remote get-url origin)"
    [[ "$origin_url" == "https://github.com/${EXPECTED_REPOSITORY}" || \
      "$origin_url" == "https://github.com/${EXPECTED_REPOSITORY}.git" ]] ||
      die "unexpected origin URL: $origin_url"
  fi
}

require_clean_tracked_tree() {
  local repo="$1"
  git -C "$repo" diff --quiet || die "tracked worktree changes detected in $repo"
  git -C "$repo" diff --cached --quiet || die "staged worktree changes detected in $repo"
}

valid_tag() {
  [[ "$1" =~ ^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$ ]]
}

custom_version_for_tag() {
  local tag="$1"
  valid_tag "$tag" || die "Cannot derive a safe custom version from tag: $tag"
  printf '%s-kernel-oops\n' "${tag#v}"
}

semver_compare() {
  local left="$1" right="$2" index
  local -a left_parts right_parts
  valid_tag "$left" || die "invalid stable semantic version: $left"
  valid_tag "$right" || die "invalid stable semantic version: $right"
  IFS=. read -r -a left_parts <<<"${left#v}"
  IFS=. read -r -a right_parts <<<"${right#v}"
  for index in 0 1 2; do
    if ((10#${left_parts[$index]} > 10#${right_parts[$index]})); then
      printf '1\n'
      return
    fi
    if ((10#${left_parts[$index]} < 10#${right_parts[$index]})); then
      printf '%s\n' '-1'
      return
    fi
  done
  printf '0\n'
}

fetch_inputs() {
  local index branch patch_ref
  local -a refspecs=("+refs/heads/${BASE_BRANCH}:${BASE_REF}")
  for index in "${!PATCH_BRANCHES[@]}"; do
    branch="${PATCH_BRANCHES[$index]}"
    patch_ref="refs/remotes/release-sync/patch-${index}"
    refspecs+=("+refs/heads/${branch}:${patch_ref}")
  done
  git fetch --force --no-tags origin "${refspecs[@]}"
}

resolve_latest_tag() {
  local override="${LATEST_TAG_OVERRIDE:-}"
  if [[ -n "$override" ]]; then
    [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]] ||
      die "a tag override is allowed only for workflow_dispatch"
    [[ "${DRY_RUN:-false}" == "true" ]] || die "a tag override requires dry-run mode"
    printf '%s\n' "$override"
    return
  fi
  gh api "repos/${UPSTREAM_REPOSITORY}/releases/latest" --jq .tag_name
}

fetch_upstream_tag() {
  local tag="$1"
  git update-ref -d "$UPSTREAM_REF" 2>/dev/null || true
  git fetch --force --no-tags "$UPSTREAM_URL" "+refs/tags/${tag}:${UPSTREAM_REF}"
  git rev-parse "${UPSTREAM_REF}^{commit}"
}

patch_id_for_commit() {
  local commit="$1" line
  line="$(git show --pretty=format: --binary "$commit" | git patch-id --stable)"
  [[ "$line" =~ ^([0-9a-f]{40})[[:space:]]+([0-9a-f]{40})$ ]] ||
    die "could not compute one stable patch ID for $commit"
  printf '%s\n' "${BASH_REMATCH[1]}"
}

write_metadata() {
  local file="$1" bundle_digest="$2" base_sha="$3" tag="$4" upstream_sha="$5"
  local candidate_sha="$6" candidate_tree="$7" head_sha="$8" patch_file="$9"
  local rebuild_current="${10}"
  jq -n -S \
    --argjson schema 2 \
    --arg repository "$EXPECTED_REPOSITORY" \
    --arg base_branch "$BASE_BRANCH" \
    --arg generated_ref "$GENERATED_REF" \
    --arg base_sha "$base_sha" \
    --arg upstream_tag "$tag" \
    --arg upstream_sha "$upstream_sha" \
    --arg candidate_sha "$candidate_sha" \
    --arg candidate_tree "$candidate_tree" \
    --arg head_sha "$head_sha" \
    --arg head_tree "$candidate_tree" \
    --arg bundle_sha256 "$bundle_digest" \
    --argjson dry_run "${DRY_RUN:-false}" \
    --argjson rebuild_current "$rebuild_current" \
    --slurpfile patches "$patch_file" \
    '{schema: $schema, repository: $repository, base_branch: $base_branch,
      generated_ref: $generated_ref, base_sha: $base_sha, upstream_tag: $upstream_tag,
      upstream_sha: $upstream_sha, candidate_sha: $candidate_sha,
      candidate_tree: $candidate_tree, head_sha: $head_sha, head_tree: $head_tree,
      bundle_sha256: $bundle_sha256, dry_run: $dry_run,
      rebuild_current: $rebuild_current, patches: $patches}' >"$file"
}

prepare() {
  local artifact_dir="${1:?prepare requires an artifact directory}"
  local artifact_name
  local tag marker comparison upstream_sha base_sha candidate_dir candidate_sha candidate_tree head_sha
  local index branch tip parent_line parent_count actual_patch_id classification disposition
  local patch_file bundle bundle_digest metadata_digest applied=0 skipped=0
  local rebuild_current="${REBUILD_CURRENT:-false}"

  require_command git
  require_command gh
  require_command jq
  require_command sha256sum
  require_runtime_repository
  require_clean_tracked_tree .
  [[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] || die "GITHUB_RUN_ID must be numeric"
  [[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || die "GITHUB_RUN_ATTEMPT must be numeric"
  artifact_name="release-sync-candidate-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  output artifact_name "$artifact_name"
  [[ "${DRY_RUN:-false}" == "true" || "${DRY_RUN:-false}" == "false" ]] || die "DRY_RUN must be true or false"
  [[ "$rebuild_current" == "true" || "$rebuild_current" == "false" ]] ||
    die "REBUILD_CURRENT must be true or false"
  if [[ "$rebuild_current" == "true" ]]; then
    [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]] ||
      die "REBUILD_CURRENT=true is allowed only for workflow_dispatch"
    [[ -z "${LATEST_TAG_OVERRIDE:-}" ]] ||
      die "REBUILD_CURRENT=true cannot be combined with a tag override"
  fi
  fetch_inputs
  base_sha="$(git rev-parse "${BASE_REF}^{commit}")"
  marker="$(git show "${base_sha}:${MARKER_FILE}")" || die "missing release marker on ${BASE_BRANCH}"
  valid_tag "$marker" || die "invalid tracked release marker: $marker"
  tag="$(resolve_latest_tag)"
  valid_tag "$tag" || die "latest tag is not a strict stable semantic version: $tag"
  upstream_sha="$(fetch_upstream_tag "$tag")"
  [[ "$upstream_sha" =~ ^[0-9a-f]{40}$ ]] || die "upstream tag did not resolve to a commit"
  comparison="$(semver_compare "$tag" "$marker")"

  output state noop
  output latest_tag "$tag"
  output previous_tag "$marker"
  output dry_run "${DRY_RUN:-false}"
  output rebuild_current "$rebuild_current"
  summary "## Upstream release preparation"
  summary "- Base: \`${BASE_BRANCH}@${base_sha}\`"
  summary "- Tracked release: \`${marker}\`"
  summary "- Resolved upstream tag: \`${tag}@${upstream_sha}\` (force-fetched from \`${UPSTREAM_REPOSITORY}\`)"

  if [[ -z "${LATEST_TAG_OVERRIDE:-}" ]]; then
    ((comparison >= 0)) || die "refusing upstream rollback from $marker to $tag"
    if ((comparison == 0)); then
      if [[ "$rebuild_current" == "false" ]]; then
        summary "- Result: clean no-op"
        return
      fi
      summary "- Current-tag rebuild: explicitly requested by workflow dispatch"
    elif [[ "$rebuild_current" == "true" ]]; then
      die "REBUILD_CURRENT=true requires the latest upstream tag to equal the tracked marker ($marker); got $tag"
    fi
  elif ((comparison == 0)); then
    summary "- Result: dry-run override equals the marker; clean no-op"
    return
  fi

  rm -rf "$artifact_dir"
  mkdir -p "$artifact_dir"
  candidate_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/release-sync-prepare.XXXXXX")"
  patch_file="$(mktemp "${RUNNER_TEMP:-/tmp}/release-sync-patches.XXXXXX")"
  trap 'git worktree remove --force "$candidate_dir" >/dev/null 2>&1 || true; rm -f "$patch_file"' RETURN
  git -c core.hooksPath=/dev/null worktree add --detach "$candidate_dir" "$upstream_sha"
  git -C "$candidate_dir" config user.name Marc
  git -C "$candidate_dir" config user.email marc@kernel-oops.com

  for index in "${!PATCH_BRANCHES[@]}"; do
    branch="${PATCH_BRANCHES[$index]}"
    tip="$(git rev-parse "refs/remotes/release-sync/patch-${index}")"
    [[ "$tip" == "${PATCH_TIPS[$index]}" ]] ||
      die "tip SHA mismatch for $branch: expected ${PATCH_TIPS[$index]}, got $tip"
    [[ "$(git cat-file -t "$tip")" == "commit" ]] || die "reviewed patch branch $branch does not point directly to a commit"
    parent_line="$(git rev-list --parents -n 1 "$tip")"
    parent_count=$(($(wc -w <<<"$parent_line") - 1))
    ((parent_count == 1)) || die "reviewed patch branch $branch must point to a non-merge commit"
    actual_patch_id="$(patch_id_for_commit "$tip")"
    [[ "$actual_patch_id" == "${PATCH_IDS[$index]}" ]] ||
      die "patch ID mismatch for $branch: expected ${PATCH_IDS[$index]}, got $actual_patch_id"

    classification="$(git cherry "$(git -C "$candidate_dir" rev-parse HEAD)" "$tip" "${tip}^")"
    if [[ "$classification" == "+ $tip" ]]; then
      disposition="applied"
      echo "Applying reviewed patch $branch ($tip, $actual_patch_id)"
      git -C "$candidate_dir" -c core.hooksPath=/dev/null cherry-pick "$tip"
      ((applied += 1))
    elif [[ "$classification" == "- $tip" ]]; then
      disposition="skipped"
      echo "Skipping upstream-equivalent patch $branch ($tip, $actual_patch_id)"
      ((skipped += 1))
    else
      die "unexpected git cherry classification for $branch: $classification"
    fi
    jq -n -c --arg branch "$branch" --arg expected_patch_id "$actual_patch_id" \
      --arg tip_sha "$tip" --arg disposition "$disposition" \
      '{branch: $branch, expected_patch_id: $expected_patch_id, tip_sha: $tip_sha,
        disposition: $disposition}' >>"$patch_file"
  done
  if git -C "$candidate_dir" ls-files --error-unmatch "$WORKFLOW_FILE" "$HELPER_FILE" >/dev/null 2>&1; then
    die "candidate unexpectedly contains dev-only automation files"
  fi
  mkdir -p "$candidate_dir/$(dirname "$MARKER_FILE")"
  printf '%s\n' "$tag" >"$candidate_dir/$MARKER_FILE"
  git -C "$candidate_dir" add "$MARKER_FILE"
  git -C "$candidate_dir" -c core.hooksPath=/dev/null commit -m "chore: sync upstream release ${tag}"
  candidate_sha="$(git -C "$candidate_dir" rev-parse HEAD)"
  candidate_tree="$(git -C "$candidate_dir" rev-parse 'HEAD^{tree}')"

  head_sha="$(
    export GIT_AUTHOR_NAME=Marc GIT_AUTHOR_EMAIL=marc@kernel-oops.com
    export GIT_COMMITTER_NAME=Marc GIT_COMMITTER_EMAIL=marc@kernel-oops.com
    printf 'chore: sync upstream release %s\n' "$tag" |
      git -C "$candidate_dir" commit-tree "$candidate_tree" -p "$base_sha"
  )"
  [[ "$(git -C "$candidate_dir" rev-parse "${head_sha}^{tree}")" == "$candidate_tree" ]] ||
    die "generated head tree differs from candidate tree"
  [[ "$(git -C "$candidate_dir" rev-parse "${head_sha}^")" == "$base_sha" ]] ||
    die "generated head is not based on the exact personal-runtime base"

  git update-ref "$BUNDLE_BASE_REF" "$base_sha"
  git update-ref "$BUNDLE_UPSTREAM_REF" "$upstream_sha"
  git update-ref "$BUNDLE_CANDIDATE_REF" "$candidate_sha"
  git update-ref "$BUNDLE_HEAD_REF" "$head_sha"
  bundle="$artifact_dir/candidate.bundle"
  git bundle create "$bundle" \
    "$BUNDLE_BASE_REF" "$BUNDLE_UPSTREAM_REF" "$BUNDLE_CANDIDATE_REF" "$BUNDLE_HEAD_REF"
  bundle_digest="$(sha256sum "$bundle" | awk '{print $1}')"
  write_metadata "$artifact_dir/metadata.json" "$bundle_digest" "$base_sha" "$tag" \
    "$upstream_sha" "$candidate_sha" "$candidate_tree" "$head_sha" "$patch_file" \
    "$rebuild_current"
  metadata_digest="$(sha256sum "$artifact_dir/metadata.json" | awk '{print $1}')"

  output state update
  output latest_tag "$tag"
  output dry_run "${DRY_RUN:-false}"
  output rebuild_current "$rebuild_current"
  output base_sha "$base_sha"
  output head_sha "$head_sha"
  output candidate_tree "$candidate_tree"
  output bundle_sha256 "$bundle_digest"
  output metadata_sha256 "$metadata_digest"
  summary "- Reviewed patches: ${applied} applied, ${skipped} skipped as upstream-equivalent"
  summary "- Candidate: \`${candidate_sha}\`; tree: \`${candidate_tree}\`"
  summary "- Generated head: \`${head_sha}\` with exact parent \`${base_sha}\`"
  summary "- Bundle SHA-256: \`${bundle_digest}\`"
  summary "- Metadata SHA-256: \`${metadata_digest}\`"
  summary "- Result: immutable candidate artifact prepared; no candidate code executed"
}

validate_metadata() {
  local metadata="$1"
  jq -e \
    --arg repository "$EXPECTED_REPOSITORY" \
    --arg base_branch "$BASE_BRANCH" \
    --arg generated_ref "$GENERATED_REF" \
    --argjson branches "$(printf '%s\n' "${PATCH_BRANCHES[@]}" | jq -R . | jq -s .)" \
    --argjson patch_ids "$(printf '%s\n' "${PATCH_IDS[@]}" | jq -R . | jq -s .)" \
    --argjson patch_tips "$(printf '%s\n' "${PATCH_TIPS[@]}" | jq -R . | jq -s .)" '
      (keys | sort) == (["base_branch", "base_sha", "bundle_sha256", "candidate_sha",
        "candidate_tree", "dry_run", "generated_ref", "head_sha", "head_tree", "patches",
        "rebuild_current", "repository", "schema", "upstream_sha", "upstream_tag"] | sort) and
      .schema == 2 and .repository == $repository and .base_branch == $base_branch and
      .generated_ref == $generated_ref and (.dry_run | type) == "boolean" and
      (.rebuild_current | type) == "boolean" and
      (.upstream_tag | test("^v(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$")) and
      ([.base_sha, .upstream_sha, .candidate_sha, .candidate_tree, .head_sha, .head_tree,
        .bundle_sha256] | all(test("^[0-9a-f]{40}$") or test("^[0-9a-f]{64}$"))) and
      (.base_sha | test("^[0-9a-f]{40}$")) and (.upstream_sha | test("^[0-9a-f]{40}$")) and
      (.candidate_sha | test("^[0-9a-f]{40}$")) and (.candidate_tree | test("^[0-9a-f]{40}$")) and
      (.head_sha | test("^[0-9a-f]{40}$")) and (.head_tree | test("^[0-9a-f]{40}$")) and
      (.bundle_sha256 | test("^[0-9a-f]{64}$")) and .candidate_tree == .head_tree and
      (.patches | type) == "array" and (.patches | length) == ($branches | length) and
      all(.patches[]; (keys | sort) == (["branch", "disposition", "expected_patch_id", "tip_sha"] | sort)) and
      [.patches[].branch] == $branches and [.patches[].expected_patch_id] == $patch_ids and
      [.patches[].tip_sha] == $patch_tips and
      all(.patches[]; (.tip_sha | test("^[0-9a-f]{40}$")) and
        (.disposition == "applied" or .disposition == "skipped"))
    ' "$metadata" >/dev/null || die "artifact metadata failed strict validation"
}

validate_artifact() {
  local artifact_dir="$1" actual_files expected_files actual_bundle_digest actual_metadata_digest
  local expected_bundle_digest="${EXPECTED_BUNDLE_SHA256:-}" expected_metadata_digest="${EXPECTED_METADATA_SHA256:-}"
  [[ -d "$artifact_dir" ]] || die "artifact directory is missing: $artifact_dir"
  actual_files="$(find "$artifact_dir" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
  expected_files=$'candidate.bundle\nmetadata.json'
  [[ "$actual_files" == "$expected_files" ]] || die "artifact contains unexpected files"
  [[ -f "$artifact_dir/candidate.bundle" && ! -L "$artifact_dir/candidate.bundle" ]] || die "invalid bundle file"
  [[ -f "$artifact_dir/metadata.json" && ! -L "$artifact_dir/metadata.json" ]] || die "invalid metadata file"
  [[ "$expected_bundle_digest" =~ ^[0-9a-f]{64}$ ]] || die "missing or invalid trusted bundle SHA-256"
  [[ "$expected_metadata_digest" =~ ^[0-9a-f]{64}$ ]] || die "missing or invalid trusted metadata SHA-256"
  actual_bundle_digest="$(sha256sum "$artifact_dir/candidate.bundle" | awk '{print $1}')"
  actual_metadata_digest="$(sha256sum "$artifact_dir/metadata.json" | awk '{print $1}')"
  [[ "$actual_bundle_digest" == "$expected_bundle_digest" ]] || die "downloaded candidate bundle SHA-256 mismatch"
  [[ "$actual_metadata_digest" == "$expected_metadata_digest" ]] || die "downloaded metadata SHA-256 mismatch"
  validate_metadata "$artifact_dir/metadata.json"
  [[ "$actual_bundle_digest" == "$(jq -er .bundle_sha256 "$artifact_dir/metadata.json")" ]] ||
    die "candidate bundle digest does not match trusted metadata"
}

metadata_value() {
  jq -er "$2" "$1"
}

import_artifact() {
  local artifact_dir="$1" repo="$2"
  local metadata="$artifact_dir/metadata.json" bundle="$artifact_dir/candidate.bundle"
  local base_sha base_marker upstream_sha upstream_tag candidate_sha candidate_tree head_sha head_tree
  local rebuild_current ref
  validate_artifact "$artifact_dir"
  git bundle verify "$bundle" >/dev/null
  git init -q "$repo"
  git -C "$repo" fetch -q "$bundle" \
    "$BUNDLE_BASE_REF:$BUNDLE_BASE_REF" \
    "$BUNDLE_UPSTREAM_REF:$BUNDLE_UPSTREAM_REF" \
    "$BUNDLE_CANDIDATE_REF:$BUNDLE_CANDIDATE_REF" \
    "$BUNDLE_HEAD_REF:$BUNDLE_HEAD_REF"
  base_sha="$(metadata_value "$metadata" .base_sha)"
  rebuild_current="$(metadata_value "$metadata" '.rebuild_current | tostring')"
  upstream_sha="$(metadata_value "$metadata" .upstream_sha)"
  upstream_tag="$(metadata_value "$metadata" .upstream_tag)"
  candidate_sha="$(metadata_value "$metadata" .candidate_sha)"
  candidate_tree="$(metadata_value "$metadata" .candidate_tree)"
  head_sha="$(metadata_value "$metadata" .head_sha)"
  head_tree="$(metadata_value "$metadata" .head_tree)"
  for ref in \
    "$BUNDLE_BASE_REF:$base_sha" "$BUNDLE_UPSTREAM_REF:$upstream_sha" \
    "$BUNDLE_CANDIDATE_REF:$candidate_sha" "$BUNDLE_HEAD_REF:$head_sha"; do
    [[ "$(git -C "$repo" rev-parse "${ref%%:*}^{commit}")" == "${ref#*:}" ]] || die "bundle ref mismatch: ${ref%%:*}"
  done
  [[ "$(git -C "$repo" rev-parse "${candidate_sha}^{tree}")" == "$candidate_tree" ]] || die "candidate tree mismatch"
  [[ "$(git -C "$repo" rev-parse "${head_sha}^{tree}")" == "$head_tree" ]] || die "head tree mismatch"
  [[ "$candidate_tree" == "$head_tree" ]] || die "tested and generated trees differ"
  [[ "$(git -C "$repo" rev-list --parents -n 1 "$head_sha")" == "$head_sha $base_sha" ]] ||
    die "generated head does not have exactly the recorded base parent"
  [[ "$(git -C "$repo" show "${head_sha}:${MARKER_FILE}")" == "$upstream_tag" ]] ||
    die "candidate marker does not match metadata"
  base_marker="$(git -C "$repo" show "${base_sha}:${MARKER_FILE}")" ||
    die "recorded base is missing its release marker"
  if [[ "$rebuild_current" == "true" ]]; then
    [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]] ||
      die "current-tag rebuild artifacts are valid only for workflow_dispatch"
    [[ "$upstream_tag" == "$base_marker" ]] ||
      die "current-tag rebuild metadata does not match the base marker"
  else
    [[ "$upstream_tag" != "$base_marker" ]] ||
      die "non-rebuild artifact unexpectedly retains the base marker"
  fi
  if git -C "$repo" ls-tree -r --name-only "$head_sha" -- "$WORKFLOW_FILE" "$HELPER_FILE" | grep -q .; then
    die "candidate contains dev-only automation files"
  fi
}

assert_candidate_unchanged() {
  local repo="$1" head_sha="$2" head_tree="$3" trusted_repo="$4" helper="$5" helper_digest="$6"
  [[ "$(git -C "$repo" rev-parse HEAD)" == "$head_sha" ]] || die "candidate HEAD changed during verification"
  [[ "$(git -C "$repo" rev-parse 'HEAD^{tree}')" == "$head_tree" ]] || die "candidate tree changed during verification"
  require_clean_tracked_tree "$repo"
  require_clean_tracked_tree "$trusted_repo"
  [[ "$(sha256sum "$helper" | awk '{print $1}')" == "$helper_digest" ]] || die "trusted helper changed during candidate execution"
}

verify() {
  local artifact_dir="${1:?verify requires an artifact directory}"
  local repo metadata upstream_sha upstream_tag head_sha head_tree trusted_repo helper helper_digest isolated_home file
  local custom_version binary smoke_home smoke_tmp expected_data_dir expected_db_path
  local version_stdout version_stderr version_expected db_stdout db_stderr db_expected
  local -a core_tests opencode_tests formatted_files db_files
  require_command git
  require_command jq
  require_command sha256sum
  require_command shellcheck
  require_command cmp
  require_command bun
  require_runtime_repository
  trusted_repo="$(git rev-parse --show-toplevel)"
  helper="$(realpath "$0")"
  helper_digest="$(sha256sum "$helper" | awk '{print $1}')"
  require_clean_tracked_tree "$trusted_repo"
  bash -n "$helper"
  shellcheck "$helper"
  summary "## Candidate verification"
  summary "- Trusted helper passed \`bash -n\` and ShellCheck"
  repo="$(mktemp -d "${RUNNER_TEMP:-/tmp}/release-sync-verify.XXXXXX")"
  metadata="$artifact_dir/metadata.json"
  import_artifact "$artifact_dir" "$repo"
  head_sha="$(metadata_value "$metadata" .head_sha)"
  head_tree="$(metadata_value "$metadata" .head_tree)"
  upstream_sha="$(metadata_value "$metadata" .upstream_sha)"
  upstream_tag="$(metadata_value "$metadata" .upstream_tag)"
  custom_version="$(custom_version_for_tag "$upstream_tag")"
  git -C "$repo" -c core.hooksPath=/dev/null checkout -q --detach "$head_sha"
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"

  isolated_home="$(mktemp -d "${RUNNER_TEMP:-/tmp}/release-sync-home.XXXXXX")"
  export HOME="$isolated_home" XDG_CONFIG_HOME="$isolated_home/.config"
  export OPENCODE_LOCAL_STATE_ROOT="$isolated_home/.local/state/opencode"
  unset OPENCODE_CONFIG OPENCODE_CONFIG_DIR OPENCODE_CONFIG_CONTENT
  unset OPENCODE_EXPERIMENTAL_INSTANCE_IDLE_TIMEOUT_MS OPENCODE_BIN OPENCODE_PID OPENCODE_SYNC_ROOT

  mapfile -d '' -t formatted_files < <(git -C "$repo" diff --name-only -z "$upstream_sha" "$head_sha" -- \
    '*.ts' '*.tsx' '*.js' '*.json' '*.md' '*.yml' '*.yaml')
  for file in "${REVIEWED_TESTS[@]}"; do
    [[ -f "$repo/$file" ]] || die "reviewed regression test is missing: $file"
    if [[ "$file" == packages/core/* ]]; then
      core_tests+=("${file#packages/core/}")
    else
      opencode_tests+=("${file#packages/opencode/}")
    fi
  done
  summary "- Imported exact head \`${head_sha}\`, tree \`${head_tree}\`"
  summary "- Pinned reviewed regression tests: ${#core_tests[@]} Core, ${#opencode_tests[@]} OpenCode"

  (cd "$repo" && bun install --frozen-lockfile --ignore-scripts)
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  if ((${#core_tests[@]})); then
    (cd "$repo/packages/core" && bun test -- "${core_tests[@]}")
    assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  fi
  if ((${#opencode_tests[@]})); then
    (cd "$repo/packages/opencode" && bun test --timeout 10000 -- "${opencode_tests[@]}")
    assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  fi
  (cd "$repo/packages/core" && bun run typecheck)
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  (cd "$repo/packages/opencode" && bun run typecheck)
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  (cd "$repo/packages/plugin" && bun run typecheck)
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  (cd "$repo/packages/plugin" && bun run build)
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  git -C "$repo" diff --check "$upstream_sha" "$head_sha"
  if ((${#formatted_files[@]})); then
    (cd "$repo" && bun x prettier --check -- "${formatted_files[@]}")
  fi
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  (
    cd "$repo/packages/opencode"
    OPENCODE_CHANNEL=prod OPENCODE_VERSION="$custom_version" \
      bun run build --single --skip-install --skip-embed-web-ui
  )
  binary="$repo/packages/opencode/dist/opencode-linux-x64/bin/opencode"
  smoke_home="$(mktemp -d "${RUNNER_TEMP:-/tmp}/release-sync-smoke-home.XXXXXX")"
  smoke_tmp="$smoke_home/tmp"
  expected_data_dir="$smoke_home/.local/share/opencode"
  mkdir -p "$smoke_tmp"
  version_stdout="$smoke_home/version.stdout"
  version_stderr="$smoke_home/version.stderr"
  version_expected="$smoke_home/version.expected"
  db_stdout="$smoke_home/db-path.stdout"
  db_stderr="$smoke_home/db-path.stderr"
  db_expected="$smoke_home/db-path.expected"
  printf '%s\n' "$custom_version" >"$version_expected"
  if ! env -u OPENCODE_DB -u OPENCODE_DISABLE_CHANNEL_DB -u OPENCODE_CHANNEL \
    -u OPENCODE_VERSION \
    HOME="$smoke_home" OPENCODE_TEST_HOME="$smoke_home" \
    XDG_CONFIG_HOME="$smoke_home/.config" XDG_CACHE_HOME="$smoke_home/.cache" \
    XDG_DATA_HOME="$smoke_home/.local/share" XDG_STATE_HOME="$smoke_home/.local/state" \
    TMPDIR="$smoke_tmp" \
    "$binary" --version >"$version_stdout" 2>"$version_stderr"; then
    die "Built binary --version smoke failed"
  fi
  [[ ! -s "$version_stderr" ]] || die "Built binary --version wrote to stderr"
  cmp -s "$version_expected" "$version_stdout" || \
    die "Built binary --version output was not byte-exact"

  expected_db_path="$expected_data_dir/opencode.db"
  printf '%s\n' "$expected_db_path" >"$db_expected"
  [[ ! -e "$expected_db_path" ]] || die "Isolated database unexpectedly existed before db path smoke"
  if ! env -u OPENCODE_DB -u OPENCODE_DISABLE_CHANNEL_DB -u OPENCODE_CHANNEL \
    -u OPENCODE_VERSION \
    HOME="$smoke_home" OPENCODE_TEST_HOME="$smoke_home" \
    XDG_CONFIG_HOME="$smoke_home/.config" XDG_CACHE_HOME="$smoke_home/.cache" \
    XDG_DATA_HOME="$smoke_home/.local/share" XDG_STATE_HOME="$smoke_home/.local/state" \
    TMPDIR="$smoke_tmp" \
    "$binary" db path >"$db_stdout" 2>"$db_stderr"; then
    die "Built binary db path smoke failed"
  fi
  [[ ! -s "$db_stderr" ]] || die "Built binary db path wrote to stderr"
  cmp -s "$db_expected" "$db_stdout" || \
    die "Built binary db path output was not byte-exact"
  mapfile -d '' -t db_files < <(find "$smoke_home" \( -name '*.db' -o -name '*.db-*' \) -print0)
  for file in "${db_files[@]}"; do
    case "$file" in
      "$expected_db_path"|"$expected_db_path-wal"|"$expected_db_path-shm")
        [[ -f "$file" && ! -L "$file" ]] || die "db path smoke created an invalid database entry: $file"
        ;;
      *) die "db path smoke created an unexpected database-like entry: $file" ;;
    esac
  done
  assert_candidate_unchanged "$repo" "$head_sha" "$head_tree" "$trusted_repo" "$helper" "$helper_digest"
  summary "- Result: focused tests, all three typechecks, plugin build, Prettier/diff checks, and prod-channel native smoke passed as \`$custom_version\`; isolated canonical \`opencode.db\` initialisation was allowed and no real database was touched"
  summary "- Final HEAD/tree and tracked-worktree integrity checks passed after every execution phase"
}

api_json() {
  local method="$1" endpoint="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    printf '%s' "$body" | gh api --method "$method" "$endpoint" --input -
  else
    gh api --method "$method" "$endpoint"
  fi
}

publish() {
  local artifact_dir="${1:?publish requires an artifact directory}"
  local repo metadata base_sha head_sha head_tree tag dry_run remote_json remote_sha lease
  local askpass run_url status_body pr_list pr_number pr_body pr_update pr_json current_base
  require_command git
  require_command gh
  require_command jq
  require_command sha256sum
  require_runtime_repository
  [[ -n "${GH_TOKEN:-}" ]] || die "GH_TOKEN is required for publishing"
  summary "## Candidate publication"
  repo="$(mktemp -d "${RUNNER_TEMP:-/tmp}/release-sync-publish.XXXXXX")"
  metadata="$artifact_dir/metadata.json"
  import_artifact "$artifact_dir" "$repo"
  base_sha="$(metadata_value "$metadata" .base_sha)"
  head_sha="$(metadata_value "$metadata" .head_sha)"
  head_tree="$(metadata_value "$metadata" .head_tree)"
  tag="$(metadata_value "$metadata" .upstream_tag)"
  dry_run="$(metadata_value "$metadata" '.dry_run | tostring')"
  [[ "$dry_run" == "false" ]] || die "publisher refuses a dry-run artifact"
  [[ "$(git -C "$repo" rev-parse "${head_sha}^{tree}")" == "$head_tree" ]] || die "publisher tree check failed"

  current_base="$(gh api "repos/${EXPECTED_REPOSITORY}/git/ref/heads/${BASE_BRANCH}" --jq .object.sha)"
  [[ "$current_base" == "$base_sha" ]] || die "personal-runtime moved before publication"
  if remote_json="$(gh api "repos/${EXPECTED_REPOSITORY}/git/ref/heads/${GENERATED_BRANCH}" 2>/dev/null)"; then
    remote_sha="$(jq -er .object.sha <<<"$remote_json")"
  else
    remote_sha=""
  fi
  lease="${GENERATED_REF}:${remote_sha}"
  askpass="$(mktemp "${RUNNER_TEMP:-/tmp}/release-sync-askpass.XXXXXX")"
  cat >"$askpass" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' x-access-token ;;
  *) printf '%s\n' "$GH_TOKEN" ;;
esac
EOF
  chmod 700 "$askpass"
  git -C "$repo" remote add publish "$PUBLISH_URL"
  GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
    git -C "$repo" push --force-with-lease="$lease" publish "$BUNDLE_HEAD_REF:$GENERATED_REF"
  [[ "$(gh api "repos/${EXPECTED_REPOSITORY}/git/ref/heads/${GENERATED_BRANCH}" --jq .object.sha)" == "$head_sha" ]] ||
    die "generated branch does not point to the verified head"

  run_url="${GITHUB_SERVER_URL:-https://github.com}/${EXPECTED_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-unknown}"
  status_body="$(jq -n --arg state success --arg context "$STATUS_CONTEXT" \
    --arg description "Verified upstream ${tag} candidate tree ${head_tree:0:12}" --arg target_url "$run_url" \
    '{state: $state, context: $context, description: $description, target_url: $target_url}')"
  api_json POST "repos/${EXPECTED_REPOSITORY}/statuses/${head_sha}" "$status_body" >/dev/null

  pr_body="$(jq -n --arg title "chore: sync upstream release ${tag}" \
    --arg body "Verified upstream release ${tag}. Exact tested head: ${head_sha}; tree: ${head_tree}. Run: ${run_url}" \
    --arg head "$GENERATED_BRANCH" --arg base "$BASE_BRANCH" \
    '{title: $title, body: $body, head: $head, base: $base}')"
  pr_list="$(gh api --method GET "repos/${EXPECTED_REPOSITORY}/pulls?state=open&base=${BASE_BRANCH}&head=kernel-oops:${GENERATED_BRANCH}")"
  [[ "$(jq 'length' <<<"$pr_list")" -le 1 ]] || die "multiple generated release-sync PRs are open"
  pr_number="$(jq -r '.[0].number // empty' <<<"$pr_list")"
  if [[ -z "$pr_number" ]]; then
    pr_json="$(api_json POST "repos/${EXPECTED_REPOSITORY}/pulls" "$pr_body")"
    pr_number="$(jq -er .number <<<"$pr_json")"
  else
    pr_update="$(jq '{title, body, base}' <<<"$pr_body")"
    pr_json="$(api_json PATCH "repos/${EXPECTED_REPOSITORY}/pulls/${pr_number}" "$pr_update")"
  fi

  pr_json="$(gh api "repos/${EXPECTED_REPOSITORY}/pulls/${pr_number}")"
  jq -e --arg head "$head_sha" --arg base "$base_sha" --arg base_branch "$BASE_BRANCH" \
    --arg generated_branch "$GENERATED_BRANCH" --arg repository "$EXPECTED_REPOSITORY" '
      .state == "open" and .head.sha == $head and .base.sha == $base and
      .head.ref == $generated_branch and .base.ref == $base_branch and
      .head.repo.full_name == $repository and .base.repo.full_name == $repository
    ' <<<"$pr_json" >/dev/null || die "PR API state does not match the verified head and base"

  GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
    git -C "$repo" push --atomic \
      --force-with-lease="refs/heads/personal-runtime:$base_sha" \
      publish "$BUNDLE_HEAD_REF:refs/heads/${BASE_BRANCH}"
  rm -f "$askpass"
  current_base="$(gh api "repos/${EXPECTED_REPOSITORY}/git/ref/heads/${BASE_BRANCH}" --jq .object.sha)"
  [[ "$current_base" == "$head_sha" ]] || die "personal-runtime does not point to the verified head after promotion"
  summary "- Posted required status \`${STATUS_CONTEXT}\` on \`${head_sha}\`"
  summary "- PR #${pr_number} recorded the exact candidate for visibility"
  summary "- Atomically promoted \`${head_sha}\` to \`${BASE_BRANCH}\` with an exact \`${base_sha}\` lease"
  summary "- Branch protection must permit this status-gated automation push and must not require a PR merge"
}

ensure_automation_label() {
  if ! gh api "repos/${EXPECTED_REPOSITORY}/labels/automation" >/dev/null 2>&1; then
    api_json POST "repos/${EXPECTED_REPOSITORY}/labels" \
      "$(jq -n '{name: "automation", color: "D93F0B", description: "Failures from repository automation"}')" >/dev/null
  fi
}

find_failure_issue() {
  local state="${1:?issue state required}"
  [[ "$state" == "open" || "$state" == "all" ]] || return 1
  gh api --method GET "repos/${EXPECTED_REPOSITORY}/issues?state=${state}&labels=automation&per_page=100" |
    jq -r --arg title "$FAILURE_TITLE" '[.[] | select(.pull_request == null and .title == $title)][0].number // empty'
}

notify() {
  local prepare_result="${PREPARE_RESULT:-unknown}" prepare_state="${PREPARE_STATE:-unknown}"
  local verify_result="${VERIFY_RESULT:-unknown}"
  local publish_result="${PUBLISH_RESULT:-unknown}" dry_run="${DRY_RUN_CONTEXT:-unknown}"
  local tag="${LATEST_TAG_CONTEXT:-unknown}" run_url result issue jobs failed body request notify_error=0
  local invariant_failure=1 workflow_failed=0
  case "${prepare_result}:${prepare_state}:${verify_result}:${publish_result}:${dry_run}" in
    success:noop:skipped:skipped:true|success:noop:skipped:skipped:false|success:update:success:skipped:true|success:update:success:success:false)
      invariant_failure=0
      ;;
  esac
  for request in "$prepare_result" "$verify_result" "$publish_result"; do
    if [[ "$request" == "failure" || "$request" == "cancelled" ]]; then
      workflow_failed=1
    fi
  done
  result=success
  ((invariant_failure == 0)) || result=failure
  run_url="${GITHUB_SERVER_URL:-https://github.com}/${EXPECTED_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-unknown}"
  summary "## Automation notification"
  summary "- Jobs: prepare=${prepare_result} (state=${prepare_state}), verify=${verify_result}, publish=${publish_result}"
  summary "- Candidate tag context: \`${tag}\`; dry-run: \`${dry_run}\`"
  summary "- Overall result: **${result}**"

  set +e
  require_runtime_repository
  ensure_automation_label || notify_error=1
  if [[ "$result" == "success" ]]; then
    issue="$(find_failure_issue open)" || notify_error=1
    if [[ "$dry_run" != "true" && -n "$issue" ]]; then
      api_json POST "repos/${EXPECTED_REPOSITORY}/issues/${issue}/comments" \
        "$(jq -n --arg body "Release sync recovered successfully in ${run_url}." '{body: $body}')" >/dev/null || notify_error=1
      api_json PATCH "repos/${EXPECTED_REPOSITORY}/issues/${issue}" '{"state":"closed"}' >/dev/null || notify_error=1
      summary "- Closed stale failure issue #${issue}"
    else
      summary "- No stale issue closure required"
    fi
    if ((notify_error != 0)); then
      echo "release-sync: issue reporting failed; inspect ${run_url}" >&2
      summary "- Warning: issue reporting failed; the run summary and logs remain available"
    fi
    return 0
  fi

  issue="$(find_failure_issue all)" || notify_error=1
  jobs="$(gh api "repos/${EXPECTED_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs" 2>/dev/null)"
  failed="$(jq -r '[.jobs[]? | .name as $job | .steps[]? |
    select(.conclusion == "failure") | "\($job): \(.name)"] | join(", ")' <<<"$jobs" 2>/dev/null)"
  body="$(cat <<EOF
The upstream release-sync automation failed its job/result invariant.

- Run: ${run_url}
- Candidate tag: ${tag}
- Prepare result/state / verify / publish: ${prepare_result}/${prepare_state} / ${verify_result} / ${publish_result}
- Dry-run: ${dry_run}
- Failed job/step context: ${failed:-unavailable; inspect the linked run logs}
- Trigger: ${GITHUB_EVENT_NAME:-unknown}
- Attempt: ${GITHUB_RUN_ATTEMPT:-unknown}

No candidate code ran with a write token. No atomic promotion is attempted unless the immutable candidate artifact has passed verification on a separate runner.
EOF
)"
  if [[ -n "$issue" ]]; then
    request="$(jq -n --arg body "$body" '{body: $body, state: "open", assignees: ["kernel-oops"], labels: ["automation"]}')"
    api_json PATCH "repos/${EXPECTED_REPOSITORY}/issues/${issue}" "$request" >/dev/null || notify_error=1
    api_json POST "repos/${EXPECTED_REPOSITORY}/issues/${issue}/comments" \
      "$(jq -n --arg body "Failure updated from ${run_url}." '{body: $body}')" >/dev/null || notify_error=1
    summary "- Updated durable failure issue #${issue}"
  else
    request="$(jq -n --arg title "$FAILURE_TITLE" --arg body "$body" \
      '{title: $title, body: $body, assignees: ["kernel-oops"], labels: ["automation"]}')"
    issue="$(api_json POST "repos/${EXPECTED_REPOSITORY}/issues" "$request" | jq -r .number)" || notify_error=1
    summary "- Created durable failure issue #${issue}"
  fi
  if ((notify_error != 0)); then
    echo "release-sync: issue reporting failed; inspect ${run_url}" >&2
    summary "- Warning: issue reporting failed; the run summary and logs remain available"
  fi
  if ((workflow_failed == 0)); then
    echo "release-sync: invalid job/result tuple" >&2
    return 1
  fi
  return 0
}

case "${1:-}" in
  prepare) prepare "${2:?prepare requires ARTIFACT_DIR}" ;;
  verify) verify "${2:?verify requires ARTIFACT_DIR}" ;;
  publish) publish "${2:?publish requires ARTIFACT_DIR}" ;;
  notify) notify ;;
  *) echo "Usage: $0 {prepare|verify|publish|notify} [ARTIFACT_DIR]" >&2; exit 2 ;;
esac
