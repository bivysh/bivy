// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in paid provider probe. Uses no account or model credentials. Run from
// the repo with BIVY_FLY_SMOKE=1 and FLY_API_TOKEN injected by a secret manager.
// The deliberately unregistered bootstrap can certify health, not enrollment.
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { flyProvider, FLY_RUNNER_IMAGE } from '../packages/core/src/ephemeral-providers/fly.js';
import type { ExecFn } from '../packages/core/src/ephemeral-provider-ports.js';
if (process.env.BIVY_FLY_SMOKE !== '1') throw new Error('Set BIVY_FLY_SMOKE=1 to authorize a short-lived paid Fly machine');
const evidencePath = process.env.BIVY_FLY_SMOKE_REPORT || '/tmp/bivy-fly-live-evidence.json';
const token = process.env.FLY_API_TOKEN;
if (!token) throw new Error('Injected Fly credential required');
const attemptId = randomUUID();
const slug = 'cert-' + attemptId;
const app = 'bivy-' + slug;
const base = 'https://api.machines.dev/v1/apps/' + app;
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
let phase = 'validate';
const report: Record<string, unknown> = { app, attemptId, image: FLY_RUNNER_IMAGE, scope: 'provider boot, native PTY, retry adoption, deletion; no account enrollment or model execution' };
const exec: ExecFn = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: AbortSignal.timeout(45000) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
async function api(path = '', method = 'GET', body?: unknown) { return exec({url: base + path, method, headers, body}); }
const args = { exec, token, config: {slug, attemptId, region: 'iad', size: 'shared-2x-4gb', ttlMinutes: 5}, userData: '', bootstrap: {relayUrl: 'wss://staging-relay.bivy.sh', controlPlaneUrl: 'https://staging-app.bivy.sh', enrollmentToken: 'unregistered-cert-' + randomUUID(), e2eKeyB64: randomBytes(32).toString('base64'), ttlMinutes: 5, provider: 'fly'} };
await writeFile(evidencePath, JSON.stringify(report), {mode: 0o600});
try {
  await flyProvider.validateToken!({exec, token});
  phase = 'create';
  const start = Date.now();
  const machine = await flyProvider.provision(args);
  report.machineId = machine.id;
  report.providerAcceptedMs = Date.now() - start;
  console.log('Fly accepted isolated certification machine.');
  phase = 'boot';
  let healthy = false;
  while (Date.now() - start < 150000) {
    const state = await flyProvider.status({exec, token, machine});
    if (state === 'gone') throw new Error('Machine disappeared before health check');
    if (state === 'running') {
      const js = "require('/usr/local/lib/node_modules/@bivy/bivy/node_modules/node-pty');fetch('http://127.0.0.1:4317/healthz').then(r=>{if(!r.ok)process.exit(1);console.log('BIVY_CERT_HEALTHY')}).catch(()=>process.exit(1))";
      const r = await api('/machines/' + machine.id + '/exec', 'POST', {cmd: 'node -e ' + "'" + js.replaceAll("'", "'\\''") + "'", timeout: 10});
      if (r.status < 300 && r.body?.exit_code === 0 && String(r.body.stdout).includes('BIVY_CERT_HEALTHY')) {
        healthy = true;
        report.remoteHealthCommandPassed = true;
        break;
      }
      report.lastExecStatus = r.status;
      report.lastExecExit = r.body?.exit_code;
      report.lastExecStderr = String(r.body?.stderr || '').replaceAll(token, '[redacted]').slice(0, 500);
      report.lastExecError = String(r.body?.error || r.body?.message || '').replaceAll(token, '[redacted]').slice(0, 300);
      if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error('Remote certification command rejected');
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!healthy) throw new Error('Packaged daemon did not become healthy within deadline');
  report.healthAndNativePtyMs = Date.now() - start;
  phase = 'retry-adoption';
  const adopted = await flyProvider.provision(args);
  if (adopted.id !== machine.id) throw new Error('Retry created another machine');
  const inventory = await api('/machines');
  if (inventory.status >= 300 || !Array.isArray(inventory.body) || inventory.body.length !== 1) throw new Error('Retry inventory did not contain exactly one machine');
  report.retryAdoptedSameMachine = true;
  report.bootPassed = true;
} catch (error) {
  report.failedPhase = phase;
  report.error = (error instanceof Error ? error.message : 'certification failed').replaceAll(token, '[redacted]');
  process.exitCode = 1;
} finally {
  await cleanup();
  await writeFile(evidencePath, JSON.stringify(report, null, 2), {mode: 0o600});
  console.log(JSON.stringify(report, null, 2));
}

async function cleanup() {
  try {
    const inventory = await api('/machines');
    if (inventory.status !== 404) {
      if (inventory.status >= 300 || !Array.isArray(inventory.body)) throw new Error('Cannot confirm cleanup inventory');
      for (const m of inventory.body) {
        if (m.config?.metadata?.['bivy-attempt'] !== attemptId) throw new Error('Foreign machine in isolated app; refusing deletion');
        await flyProvider.destroy({exec, token: token!, machine: {id: m.id, app, provider: 'fly', name: app, region: m.region, status: 'running', ip: null, createdAt: m.created_at}});
      }
      const empty = await api('/machines');
      if (empty.status !== 404) {
        if (empty.status >= 300 || !Array.isArray(empty.body) || empty.body.length) throw new Error('Machine deletion not confirmed');
        const deleted = await api('', 'DELETE');
        if (deleted.status >= 300 && deleted.status !== 404) throw new Error('App deletion failed');
      }
    }
    const absent = await api();
    if (absent.status !== 404) throw new Error('App absence not confirmed');
    report.cleanupConfirmed = true;
  } catch { report.cleanupConfirmed = false; process.exitCode = 1; }
}
