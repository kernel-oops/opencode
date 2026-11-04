# Background tasks CLI plugin

Existing background task presentation through public sidebar and router
interfaces. It registers **`sidebar.content` only**, not a session panel.
The server remains the sole owner of status, cancellation, adoption, scheduling
and independent-session authority. This package adds no backend action.

## Compatibility

Minimum tested host: a compatible **OpenCode 2.0.30 fork**, with both read-only
capabilities below. This is **not** a claim of support for stock upstream 2.0.30
or every later version:

- `data.session.descendants.sync` and `.invalidate` for cold transitive hydration;
- `data.session.task.get`, `.sync` and `.observe` for shared task observation.

Tested with Bun **1.4.2**, Effect **4.0.1** in the host, OpenTUI **0.5.17** and
Solid **1.9.15**. Prebuilt code imports host runtime module IDs, not another copy
of Solid/OpenTUI. Optional peers describe that host ABI; installing peers does not
add the missing fork capabilities. There is no runtime Effect or Client dependency.
Unsupported hosts show one warning and register nothing; there is no fallback
polling cache or inference of completion from missing data.

## Installation

Package name is provisional until publication is authorised; availability is not
implied. Configure the **package root**, not an invented `/tui` package name, in
the global CLI settings (`$XDG_CONFIG_HOME/opencode/cli.json`, normally
`~/.config/opencode/cli.json`):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@kernel-oops/opencode-background-tasks"]
}
```

For a locally unpacked candidate, replace the package name with the package
directory, for example `"./plugins/background-tasks"`, relative to CLI settings.
Do not add a server plugin declaration: this is a terminal-only package.
Remove the CLI entry to disable it. A client attached with `opencode --server
https://server.example` still loads its own local CLI settings; the server must
provide the compatible authoritative APIs. Normal server authentication applies.

## Behaviour and privacy

One host task timer/in-flight read is shared by all views and built-in controls.
The last observer releases its cache; late replies cannot resurrect disposed
state. Separate Data instances do not share caches across servers/projects.
Shell rows show the first line of each running command, which may be sensitive.

The `./session` export contains pure session-tree/activity helpers as prebuilt
JavaScript with declarations. No source config, account settings or history is
part of the distribution. Source authoring/test dependencies are not consumer
dependencies. Licence: MIT; the original notice is preserved in `LICENSE`.
