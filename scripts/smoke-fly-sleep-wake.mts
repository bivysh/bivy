// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in paid provider probe for sleeping machines. Uses no account or model
// credentials. Run from the repo with BIVY_FLY_SMOKE=1 and FLY_API_TOKEN
// injected by a secret manager:
//
//   BIVY_FLY_SMOKE=1 FLY_API_TOKEN=… npx tsx scripts/smoke-fly-sleep-wake.mts
//
// Boots a sleepOnIdle machine with a volume, writes a marker to the volume,
// then repeats stop → wake → daemon healthy, recording each wake latency and
// checking the marker survived. Also tries Fly suspend → start once. Always
// destroys the machine, volume and app. The bootstrap is deliberately
// unregistered, so this measures provider + daemon start, not enrollment.
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { flyProvider } from '../packages/core/src/ephemeral-providers/fly.js';
import type { ExecFn } from '../packages/core/src/ephemeral-provider-ports.js';
import type { EphemeralMachine } from '../packages/core/src/ephemeral-machine.js';

if (process.env.BIVY_FLY_SMOKE !== '1') throw new Error('Set BIVY_FLY_SMOKE=1 to authorize a short-lived paid Fly machine and volume');
const token = process.env.FLY_API_TOKEN || '';
if (!token) throw new Error('Injected Fly credential required');
const evidencePath = process.env.BIVY_FLY_SMOKE_REPORT || '/tmp/bivy-fly-sleep-wake.json';
const region = process.env.BIVY_FLY_SMOKE_REGION || 'iad';
const size = process.env.BIVY_FLY_SMOKE_SIZE || 'shared-4x-8gb';
const rounds = Math.max(1, Number(process.env.BIVY_FLY_SMOKE_ROUNDS) || 3);
const attemptId = randomUUID();
const slug = 'sleep-' + attemptId.slice(0, 18);
const app = 'bivy-' + slug;
const base = 'https://api.machines.dev/v1/apps/' + app;
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
const report: Record<string, unknown> = { app, region, size, scope: 'sleeping machine: volume persistence and stop/suspend → start latency; no enrollment or model execution' };
const exec: ExecFn = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: AbortSignal.timeout(45000) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const api = (path: string, method = 'GET', body?: unknown) => exec({ url: base + path, method, headers, body });
const redact = (value: unknown) => String(value ?? '').replaceAll(token, '[redacted]').slice(0, 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const save = () => writeFile(evidencePath, JSON.stringify(report, null, 2), { mode: 0o600 });

async function run(machine: EphemeralMachine, cmd: string) {
  const r = await api('/machines/' + machine.id + '/exec', 'POST', { cmd, timeout: 10 });
  return { ok: r.status < 300 && r.body?.exit_code === 0, stdout: String(r.body?.stdout || ''), status: r.status };
}
/** Daemon answering /healthz is the "awake" milestone a client would wait for. */
async function untilHealthy(machine: EphemeralMachine, since: number, deadlineMs = 150000) {
  const js = "fetch('http://127.0.0.1:4317/healthz').then(r=>{if(!r.ok)process.exit(1);console.log('BIVY_HEALTHY')}).catch(()=>process.exit(1))";
  while (Date.now() - since < deadlineMs) {
    if (await flyProvider.status({ exec, token, machine }) === 'running') {
      const r = await run(machine, "node -e '" + js + "'");
      if (r.ok && r.stdout.includes('BIVY_HEALTHY')) return Date.now() - since;
      if ([400, 401, 403].includes(r.status)) throw new Error('Remote health command rejected');
    }
    await sleep(500);
  }
  throw new Error('Daemon did not become healthy within deadline');
}
async function untilState(machine: EphemeralMachine, want: string, since: number, deadlineMs = 60000) {
  while (Date.now() - since < deadlineMs) {
    if (await flyProvider.status({ exec, token, machine }) === want) return Date.now() - since;
    await sleep(500);
  }
  throw new Error('Machine did not reach ' + want);
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

let machine: EphemeralMachine | undefined;
let phase = 'create';
await save();
try {
  const start = Date.now();
  machine = await flyProvider.provision({
    exec, token, userData: '',
    config: { slug, attemptId, region, size, ttlMinutes: 15, persistentDiskGb: 5 },
    bootstrap: { relayUrl: 'wss://staging-relay.bivy.sh', controlPlaneUrl: 'https://staging-app.bivy.sh', enrollmentToken: 'unregistered-sleep-' + randomUUID(), e2eKeyB64: randomBytes(32).toString('base64'), ttlMinutes: 15, provider: 'fly', sleepOnIdle: true },
  });
  report.machineId = machine.id;
  phase = 'first-boot';
  report.firstBootHealthyMs = await untilHealthy(machine, start);

  phase = 'write-marker';
  const marker = randomUUID();
  if (!(await run(machine, `sh -c 'echo ${marker} > /data/home/bivy-sleep-marker'`)).ok) throw new Error('Could not write the volume marker');

  const wakes: number[] = [];
  for (let i = 0; i < rounds; i++) {
    phase = 'stop-' + i;
    const stopAt = Date.now();
    const stopped = await api('/machines/' + machine.id + '/stop', 'POST', {});
    if (stopped.status >= 300) throw new Error('stop failed: ' + redact(stopped.body?.error));
    await untilState(machine, 'stopped', stopAt);
    phase = 'wake-' + i;
    const wakeAt = Date.now();
    await flyProvider.wake!({ exec, token, machine });
    wakes.push(await untilHealthy(machine, wakeAt));
  }
  report.stopWakeHealthyMs = wakes;
  report.stopWakeHealthyMedianMs = median(wakes);

  phase = 'check-marker';
  report.volumePersisted = (await run(machine, 'cat /data/home/bivy-sleep-marker')).stdout.trim() === marker;

  phase = 'suspend';
  const suspended = await api('/machines/' + machine.id + '/suspend', 'POST', {});
  if (suspended.status < 300) {
    await untilState(machine, 'stopped', Date.now());
    const resumeAt = Date.now();
    await flyProvider.wake!({ exec, token, machine });
    report.suspendWakeHealthyMs = await untilHealthy(machine, resumeAt);
  } else {
    report.suspendUnavailable = redact(suspended.body?.error || suspended.status);
  }
  report.ok = report.volumePersisted === true;
} catch (error) {
  report.failedPhase = phase;
  report.error = redact((error as Error)?.message || error);
  process.exitCode = 1;
} finally {
  try {
    if (machine) await flyProvider.destroy({ exec, token, machine });
    else await api('', 'DELETE');
    report.appGone = (await api('')).status === 404;
  } catch (error) {
    report.cleanupError = redact((error as Error)?.message || error);
    process.exitCode = 1;
  }
  await save();
  console.log(JSON.stringify(report, null, 2));
}
