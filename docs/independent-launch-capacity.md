# Independent launch capacity

The native `new_session` tool has no numerical caps on unresolved launches, either per creator or globally. Each launch still passes the normal permission, identity, canonical repository and work-directory checks.

The transactional ledger retains unresolved reservations and enforces exclusive write-directory and project ownership keys. Same-key retries remain idempotent; changed payloads conflict. Removing numerical caps does not release, transfer, delete or relaunch existing work.

Fresh launches require a distinct existing linked Git write worktree under `/mnt/crypt/home/opencode/worktrees/`, not the canonical checkout. Git repository identity, common Git directory and linked-worktree membership establish association; saved worktree inventory is neither required nor sufficient. Excluded roots and absolute, non-symlink top-level identity checks still apply. Existing launch keys reconcile before fresh-directory validation, including legacy launches whose write directory was canonical.

The owner remains a top-level session registered in the canonical project so it appears in that project's session list. Busy, suspended or inbox-pending canonical sessions do not conflict with a distinct write worktree. Ordinary sessions with unresolved work in the actual write directory still block launches. Unresolved launch reservations exclude equal, ancestor and descendant write roots, and the same project ownership key; disjoint write roots with distinct keys may proceed. Ambiguous creation, admission or start outcomes retain their reservations.

Registration is not a filesystem sandbox or a new permission grant. All assigned writes must use absolute paths within the assigned write worktree, and owners must pass that exact path and the restrictions to workers and reviewers. Relative file paths and shell defaults remain canonical. Normal external-directory and action permissions remain in force; this tool does not automatically allow writes.

Only eligible registered top-level restricted build controllers may launch owners. Delegated owners and descendants cannot recursively launch independent owners. Closure still requires an idle owner and idle descendants, and permanently fences their development authority while retaining their history.
