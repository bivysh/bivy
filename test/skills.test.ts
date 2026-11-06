// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
// Agent Skills on a machine: installed by hand or from a plugin, listed for
// every session's agent, and read on demand.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionInstructions } from "../src/agent-instructions.js";
import { installPlugin } from "../src/plugins/store.js";
import { findSkill, installSkill, listSkills, removeSkill, renderSkill } from "../src/skills.js";

function skillFolder(name: string, description: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bivy-skill-src-")), name);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nRun scripts/go.sh.\n`);
  fs.writeFileSync(path.join(dir, "scripts", "go.sh"), "echo go\n");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref\n");
  return dir;
}

function pluginWithSkills(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-skill-plugin-"));
  fs.writeFileSync(path.join(dir, "bivy.plugin.yaml"), `apiVersion: bivy.sh/v1alpha1
kind: Plugin
metadata: { id: team-skills, name: Team skills, version: 1.0.0 }
contributes:
  skills:
    - { name: release-notes, file: skills/release-notes/SKILL.md }
    - { name: pdf, file: skills/pdf/SKILL.md }
`);
  for (const name of ["release-notes", "pdf"]) {
    fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The plugin's ${name}.\n---\nPlugin body.\n`);
  }
  return dir;
}

test("user and plugin skills reach every session's instructions; a user skill shadows a plugin's", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "bivy-skills-data-"));
  try {
    assert.equal(sessionInstructions(data)?.text.includes("Skills installed"), false, "no skills, no index");

    const installed = installSkill(skillFolder("pdf", "Fill and extract PDF forms. Use for any .pdf task."), { dataDir: data });
    assert.ok(fs.existsSync(path.join(installed.dir, "scripts", "go.sh")), "the skill's files come along");
    assert.ok(!fs.existsSync(path.join(installed.dir, ".git")), "dot-folders do not");
    installPlugin(pluginWithSkills(), { dataDir: data });

    assert.deepEqual(listSkills(data).map((skill) => [skill.name, skill.source]), [["pdf", "user"], ["release-notes", "team-skills"]]);
    const text = sessionInstructions(data)!.text;
    assert.match(text, /- pdf: Fill and extract PDF forms\. Use for any \.pdf task\./);
    assert.match(text, /- release-notes: The plugin's release-notes\./);
    assert.match(text, /bivy skill show <name>/);

    const shown = renderSkill(findSkill("pdf", data)!);
    assert.match(shown, new RegExp(`Skill folder: ${installed.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(shown, /Run scripts\/go\.sh\./);
    assert.doesNotMatch(shown, /^---/m, "front matter is not repeated");

    assert.throws(() => installSkill(skillFolder("pdf", "again"), { dataDir: data }), /already installed/);
    assert.equal(removeSkill("pdf", data), true);
    assert.equal(findSkill("pdf", data)?.source, "team-skills", "the plugin's skill is used once the user's is gone");
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
