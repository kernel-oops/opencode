import { Effect } from "effect"
import { Git } from "../git.js"
import { Hash } from "@opencode/util/hash"
import { AbsolutePath } from "../schema.js"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

// Discovery also returns nothing for broken or unreadable Git metadata; that is not proof of a non-Git tree.
const hasGitEntry = (directory: string) =>
  Effect.promise(async () => {
    for (let current = directory; ; current = path.dirname(current)) {
      const found = await lstat(path.join(current, ".git")).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
      )
      if (found) return true
      if (current === path.dirname(current)) return false
    }
  })

/** Read current project identity, without resolving/persisting project inventory. */
export const verify = Effect.fn("SessionProjectAuthority.verify")(function* (
  git: Git.Interface,
  projectID: string,
  canonical: string,
  workdir: string,
) {
  const repo = yield* git.repo.discover(AbsolutePath.make(canonical))
  if (!repo)
    return (
      projectID === Hash.fast(`directory:${canonical}`) &&
      (workdir === canonical || workdir.startsWith("/mnt/crypt/home/opencode/worktrees/")) &&
      (workdir === canonical || !/\/syncthing\//i.test(workdir)) &&
      !/\/(private|\.config|\.opencode)(\/|$)/.test(workdir) &&
      canonical !== "/mnt/crypt/home/syncthing/Development/planefolio" &&
      !(yield* hasGitEntry(canonical)) &&
      !(yield* hasGitEntry(workdir))
    )
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
