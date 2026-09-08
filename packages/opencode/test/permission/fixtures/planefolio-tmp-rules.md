# PlaneFolio temporary-read permission fixture

`planefolio-tmp-rules.json` is the relevant permission projection of the canonical
configuration on 2026-09-08, not a synthetic empty or allow-all ruleset:

- Global: `/mnt/crypt/home/syncthing/Development/OpencodePersonal/config/opencode/opencode.json`
- Project: `/mnt/crypt/home/opencode/Development/planefolio/opencode.json`
- Agent: global `agent.build.permission`

Global and project permission objects are recursively merged in insertion order;
the array contains the relevant default rules, merged user rules, then agent rules
in the order used by `Permission.fromConfig`/`Permission.merge`. It preserves `*`,
Read, Grep, Glob, external-directory and edit permissions (the latter also proves
unrelated tool denies do not block this policy). Other tool-only rules and dynamic
unrelated default tool-output whitelists are omitted. No credentials are included.

The exact `/`, `/home/marc` and `/mnt/crypt` external-directory denies are retained.
The pipeline matrix uses this fixture for every case. `directory-boundary-ask`
adds a final `/tmp/*: ask` boundary rule to exercise the deterministic boundary
branch as well as the primary permission; `directory-allow` uses the unmodified
fixture. `descendant-deny` adds a relevant Read deny and must remain pending.
