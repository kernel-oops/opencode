# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

### Deterministic temporary read permission (Linux, opt-in)

`permission_reviewer.temporary_read_allow: true` allows registered built-in Read,
Grep and Glob requests whose canonical target is `/tmp` or a descendant. It
covers both `external_directory` and the primary tool permission without calling
the reviewer/provider. It is independent of the reviewer's automatic risk-policy
allowance. Omit it (the default) to retain the existing permission flow.

Static denies and plugin denies/asks remain authoritative. Resolved absolute,
project-relative and basename spellings are also checked against applicable deny
rules, including Read denies for a directly named Grep file. Directory requests
with a possible descendant deny or an uncertain pattern conservatively use normal
permissions, rather than assume their descendants are exempt. Exact canonical
absolute denies outside the requested subtree are disjoint: an exact `/` deny,
for example, denies `/` itself, not `/tmp`. Wildcards, relative patterns and
non-canonical spellings remain uncertain. Ordinary static permission evaluation
retains last-match precedence and can finish before this policy runs. When reached,
the additional pathname/descendant guard deliberately retains potentially relevant
earlier denies even if later allows overlap: it does not attempt to prove that an
allow cancels a sensitive descendant deny. Paths containing parent traversal, symlink
aliases/escapes, hard-linked files, non-regular files and different target mounts
are not automatically authorised. Other tools, custom/MCP tools and outside paths
retain their normal permissions; this does not grant execution or edit access.

This is a configured accidental-harm policy, not a sandbox or an attestation of
recursive filesystem confinement. Existing tool verification remains in place.
The audit log rule is `registered-linux-tmp-read-v1`, with `effectsBound: false`;
no durable learned allowance is minted. Directory contents may change, and
recursive search does not claim protection against privileged same-device bind
mount manipulation. Pinned external text reads still reject target identity,
content and mount changes, but unrelated sibling creation/deletion no longer
invalidates the parent descriptor.
