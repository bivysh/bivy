# Example ACP agent plugin

This runnable fixture demonstrates the complete local authoring loop without
loading plugin code into Bivy.

```bash
cd examples/plugins/acp-agent
npm link
bivy plugin validate .
bivy plugin doctor .
bivy plugin test .
bivy plugin install .
bivy restart
```

`npm link` only places the example executable on `PATH`; Bivy's plugin install
copies and pins the declarative manifest, never package code. The agent
implements the minimum ACP methods needed for initialize, session creation, and
an echo prompt.

Remove it with:

```bash
bivy plugin remove example-acp-agent
npm unlink -g bivy-example-acp-agent
```
