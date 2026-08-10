#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
/** Materialize the SDK's canonical schema object as an editor-friendly JSON file. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = path.join(root, "packages", "plugin-sdk", "dist", "schema.js");
const output = path.join(root, "packages", "plugin-sdk", "schema", "bivy.plugin.schema.json");
const { PLUGIN_MANIFEST_SCHEMA } = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(PLUGIN_MANIFEST_SCHEMA, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, output)}`);
