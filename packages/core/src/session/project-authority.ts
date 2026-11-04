import { Effect } from "effect"
import { Git } from "../git.js"
import { Hash } from "@opencode/util/hash"
import { AbsolutePath } from "../schema.js"
import { realpath } from "node:fs/promises"

/** Read current repository identity, without resolving/persisting project inventory. */
export const verify = Effect.fn("SessionProjectAuthority.verify")(function* (
  git: Git.Interface,
  projectID: string,
  canonical: string,
  workdir: string,
) {
  const repo = yield* git.repo.discover(AbsolutePath.make(canonical))
  if (!repo) return false
  if (repo.worktree !== canonical || repo.gitDirectory !== repo.commonDirectory) return false
  const origin = yield* git.remote.get(repo)
  let remoteID: string | undefined
  if (origin) {
    const parsed = URL.parse(origin.trim())
    const scp = origin.trim().match(/^([^@/:]+@)?([^/:]+):(.+)$/)
    const host = parsed && parsed.protocol !== "file:" ? parsed.hostname : scp?.[2]
    const name = parsed && parsed.protocol !== "file:" ? parsed.pathname : scp?.[3]
    if (host && name)
      remoteID = Hash.fast(
        `git-remote:${host.toLowerCase()}/${name
          .replace(/^\/+/, "")
          .replace(/\.git\/?$/, "")
          .replace(/\/+$/, "")}`,
      )
  }
  // A cached project ID is inventory, not proof that a replaced repository is
  // still the same project. Unknown/custom identities deliberately fail closed.
  const id = remoteID ?? (yield* git.history.rootCommits(repo))[0]
  if (!id || id !== projectID) return false
  if (workdir === canonical) return true
  const target = yield* git.repo.discover(AbsolutePath.make(workdir))
  if (!target || target.worktree !== workdir) return false
  const common = yield* Effect.tryPromise({ try: () => realpath(target.commonDirectory), catch: () => undefined }).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  if (common !== repo.commonDirectory) return false
  return yield* git.worktree.list(repo).pipe(
    Effect.map((items) => items.some((item) => item.directory === workdir && item.kind === "linked")),
    Effect.orElseSucceed(() => false),
  )
})
