# Changelog

## 2.0.30

- Extract the existing background task sidebar and bounded output dialog through
  public CLI slots, dialogs, navigation and keymaps.
- Share the compatible host's read-only task observation; no second scheduler,
  polling cache, cancellation endpoint or permission authority.
- Provide prebuilt TUI and pure session-helper JavaScript with helper declarations.
- Warn and register nothing on hosts missing the required fork capabilities.
