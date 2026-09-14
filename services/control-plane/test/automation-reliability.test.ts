// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createPgMemStore } from '../src/pg-mem-store.js';
import { normalizeSchedule, processDueSchedules } from '../src/schedule.js';

const store = createPgMemStore();
await store.init();
const account = await store.findOrCreateAccount('reliability@example.com');
const expire = async (id: string) => {
  await (store as unknown as { query(sql: string, args: unknown[]): Promise<unknown> }).query(
    'UPDATE work_items SET lease_expires_at=$2 WHERE id=$1', [id, new Date('2000-01-01')]);
};
try {
  for (const status of ['pending','running','cancelled'] as const) {
    const run = await store.enqueueAutomationRun(account.id, {source:'manual',title:status,maxAttempts:3});
    if (status !== 'pending') {
      await store.claimWorkItem(account.id,'node',run.id);
      await store.transitionAutomationRun(account.id,run.id,'running');
    }
    await store.appendRunEvidence(account.id,run.id,{checks:[{name:'test',status:'failed'}]});
    if (status === 'cancelled') await store.cancelAutomationRun(account.id,run.id);
    const retry = await store.retryAutomationRun(account.id,run.id);
    assert.equal(retry?.transitioned,false,`${status} must not become retryable because of checks`);
    assert.equal(retry?.run.status,status);
  }
  const capped = await store.enqueueAutomationRun(account.id,{source:'manual',title:'One attempt',maxAttempts:1});
  await store.claimWorkItem(account.id,'node',capped.id,'claim-one');
  await expire(capped.id);
  assert.equal(await store.claimWorkItem(account.id,'other',capped.id,'claim-two'),undefined);
  assert.equal((await store.getAutomationRun(account.id,capped.id))?.status,'needs_attention');

  const run = await store.enqueueAutomationRun(account.id,{source:'manual',title:'Fenced',maxAttempts:3});
  await store.claimWorkItem(account.id,'same-node',run.id,'old-process');
  await expire(run.id);
  assert.equal(await store.renewWorkItemLease(account.id,'same-node',run.id,'old-process'),undefined);
  const claimed = await store.claimWorkItem(account.id,'same-node',run.id,'new-process');
  assert.equal(claimed?.attempt,2);
  assert.equal(claimed?.claimToken,'new-process');
  for (const stale of ['old-process','']) {
    assert.equal(await store.ownsWorkClaim(account.id,'same-node',run.id,stale),false);
    assert.equal(await store.renewWorkItemLease(account.id,'same-node',run.id,stale),undefined);
    assert.equal(await store.completeWorkItem(account.id,run.id,'same-node',stale),undefined);
    assert.equal(await store.appendRunEvidence(account.id,run.id,{output:{branch:'bad'}},'same-node',stale),undefined);
  }
  const next = await store.advanceWorkItemAttempt(account.id,'same-node',run.id,'new-process',2);
  assert.equal(next?.attempt,3);
  assert.equal((await store.advanceWorkItemAttempt(account.id,'same-node',run.id,'new-process',2))?.attempt,3,'lost reservation response is idempotent');
  assert.equal(await store.advanceWorkItemAttempt(account.id,'same-node',run.id,'new-process',3),undefined);
  await store.transitionAutomationRun(account.id,run.id,'running',undefined,'same-node','new-process');
  await expire(run.id);
  assert.equal((await store.completeWorkItem(account.id,run.id,'same-node','new-process'))?.status,'succeeded','delayed durable result can reconcile an unchanged claim without restarting work');

  assert.throws(() => normalizeSchedule({kind:'cron',expression:'* * * * * *',timezone:'UTC'}),/five-field/);
  const schedule = normalizeSchedule({kind:'cron',expression:'* * * * *',timezone:'UTC'});
  let healthy = false;
  const originalError = console.error;
  console.error = () => {};
  try {
    const count = await processDueSchedules({
      async listDueAutomationDefinitions() { return ['bad','good'].map(id => ({id,accountId:id,name:id,enabled:true,nextRunAt:'2026-01-01T00:00:00.000Z',schedule,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'})); },
      async enqueueScheduledOccurrence(_account,id) { if(id==='bad') throw new Error('poison row'); healthy=true; return run; },
    },new Date('2026-01-01T00:00:00Z'));
    assert.equal(count,1);
    assert.equal(healthy,true);
  } finally { console.error = originalError; }
  console.log('✓ cancellation precedence, durable attempt budgets, same-node fencing, delayed result reconciliation, scheduler isolation');
} finally { await store.close(); }
