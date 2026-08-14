# @bivy/plugin-sdk

Node.js types and tooling for authoring declarative Bivy plugins.

```ts
import {
  parsePluginManifest,
  checkPluginCompatibility,
  doctorPluginManifest,
} from "@bivy/plugin-sdk";

const result = parsePluginManifest(source);
if (!result.ok) throw new Error(result.errors.join("\n"));

const compatibility = checkPluginCompatibility(result.manifest!, "0.10.1");
```

The package also exports the schema object as `PLUGIN_MANIFEST_SCHEMA`. Editors
and other languages can consume the packaged `@bivy/plugin-sdk/schema.json`.

The current `bivy.sh/v1alpha1` contract supports out-of-process process and ACP
agent adapters. It does not load plugin code into the Bivy daemon.

See [the plugin guide](https://github.com/bivysh/bivy/blob/main/docs/plugins.md)
for the complete manifest and CLI reference.
