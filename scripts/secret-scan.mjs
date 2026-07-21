#!/usr/bin/env node
// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const patterns = [
  { name: "OpenAI/Anthropic-style API key", re: /\b(?:sk-ant|sk-proj|sk-live|sk_test|sk-[A-Za-z0-9])[A-Za-z0-9_-]{16,}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "Stripe key", re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "Resend key", re: /\bre_[A-Za-z0-9_]{20,}\b/g },
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g },
];

const allowPath = (p) => !/node_modules|\.git\//.test(p) && !/package-lock\.json$/.test(p);
const redact = (s) => s.length <= 10 ? "[redacted]" : `${s.slice(0, 4)}…${s.slice(-4)}`;
const findings = [];

// A match is benign if the value itself, or the text immediately around it,
// marks it as a fixture. Checking only the matched substring misses cases like
// `placeholder="-----BEGIN RSA PRIVATE KEY-----"`, where the giveaway is the
// surrounding context rather than the match.
const BENIGN = /change-me|example|placeholder|fixture|dummy|sample|test-secret|devsecret|dev-relay-secret|ABCDEFGHIJKLMNOPQRSTUVWXYZ/i;
const CONTEXT = 48;

function scanText(source, text) {
  for (const p of patterns) {
    for (const m of text.matchAll(p.re)) {
      const value = m[0];
      if (BENIGN.test(value)) continue;
      const start = Math.max(0, m.index - CONTEXT);
      const window = text.slice(start, m.index + value.length + CONTEXT);
      if (BENIGN.test(window)) continue;
      findings.push({ source, rule: p.name, value: redact(value) });
      if (findings.length > 100) return;
    }
  }
}

function scanCurrentTree() {
  const ls = spawnSync("git", ["ls-files", "-z"], { encoding: "buffer" });
  if (ls.status !== 0) throw new Error("git ls-files failed");
  for (const raw of ls.stdout.toString("utf8").split("\0")) {
    if (!raw || !allowPath(raw)) continue;
    let stat;
    try { stat = fs.statSync(raw); } catch { continue; }
    if (!stat.isFile() || stat.size > 1024 * 1024) continue;
    const buf = fs.readFileSync(raw);
    if (buf.includes(0)) continue;
    scanText(raw, buf.toString("utf8"));
    if (findings.length > 100) return;
  }
}

function scanHistory() {
  const log = spawnSync("git", ["log", "--all", "--full-history", "--patch", "--no-ext-diff", "--", ".", ":(exclude)package-lock.json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (log.status !== 0 && log.status !== null) throw new Error("git log failed");
  scanText("git history", log.stdout || "");
}

scanCurrentTree();
if (!process.argv.includes("--current-only")) scanHistory();

if (findings.length > 0) {
  console.error(`Secret scan found ${findings.length} potential leak(s):`);
  for (const f of findings.slice(0, 50)) console.error(`- ${f.source}: ${f.rule}: ${f.value}`);
  if (findings.length > 50) console.error(`…and ${findings.length - 50} more`);
  process.exit(1);
}
console.log("Secret scan passed");
