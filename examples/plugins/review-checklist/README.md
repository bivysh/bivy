# Review checklist (example plugin)

A widget, the tool that feeds it live data, and a guide, in one plugin:

- `widgets/checklist.html` — a checklist that runs in the chat. It saves what is
  ticked (`bivy.setState`) and sends "done …; left …" to the agent on Send.
- `tools/changed-files.mjs` — the files git reports as changed in the session's
  workspace. `widgets: true` lets the checklist call it (`bivy.call`).
- `guides/review-checklist.md` — when an agent should place it.

```bash
bivy plugin install examples/plugins/review-checklist
bivy tools run changed_files
bivy guide review-checklist
```

See [Plugins](../../../docs/plugins.md) and [Chat widgets](../../../docs/widgets.md).
