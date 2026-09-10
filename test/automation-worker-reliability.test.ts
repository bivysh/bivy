// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ControlPlaneTaskPoller, type WorkItem } from '../src/control-plane-tasks.js';
import { WorkResultOutbox } from '../src/work-result-outbox.js';

const cfg = {controlPlaneUrl:'https://cp.test',enrollmentToken:'test',labels:['bivy'],pollMs:60000};
const item: WorkItem = {id:'run',label:'bivy',source:'schedule',status:'pending',title:'Work',attempt:1};
type Access = {runOne(item:WorkItem):Promise<void>;tick():Promise<void>};
const access = (poller:ControlPlaneTaskPoller) => poller as unknown as Access;
const response = (body:unknown={},status=200) => new Response(JSON.stringify(body),{status});
const original = globalThis.fetch;
const directory = mkdtempSync(path.join(tmpdir(),'bivy-work-results-'));
try {
  let completions=0;
  let executions=0;
  const claim = {...item,attempt:2,claimToken:'current-worker',leaseExpiresAt:new Date(Date.now()+10000).toISOString(),targetKind:'existing_session',targetSessionId:'resume-me'};
  globalThis.fetch = async (url,init) => {
    const endpoint=String(url);
    if(endpoint.endsWith('/claim')) return response({item:claim});
    assert.equal(new Headers(init?.headers).get('x-bivy-work-claim'),'current-worker');
    if(endpoint.endsWith('/complete')) return response({},++completions===1?503:200);
    return response({});
  };
  await access(new ControlPlaneTaskPoller(cfg,async received => {
    executions++;
    assert.equal(received.attempt,2);
    assert.equal(received.targetSessionId,'resume-me');
  },undefined,{resultDirectory:directory,sleep:async()=>{}})).runOne(item);
  assert.equal(completions,2);
  assert.equal(executions,1,'retry outcome delivery, not the agent');
  assert.deepEqual(new WorkResultOutbox(directory,`${cfg.controlPlaneUrl}:${cfg.enrollmentToken}`).list(),[]);

  const outbox = new WorkResultOutbox(directory,`${cfg.controlPlaneUrl}:${cfg.enrollmentToken}`);
  outbox.put({id:'finished-before-restart',action:'complete',claimToken:'old-process'});
  const calls:string[]=[];
  globalThis.fetch = async url => {calls.push(String(url));return response({items:[]});};
  await access(new ControlPlaneTaskPoller(cfg,async()=>{throw Error('must not run');},undefined,{resultDirectory:directory})).tick();
  assert.match(calls[0],/finished-before-restart\/complete$/);
  assert.deepEqual(new WorkResultOutbox(directory,`${cfg.controlPlaneUrl}:${cfg.enrollmentToken}`).list(),[]);

  let aborted=false;
  let terminal=false;
  globalThis.fetch = async url => {
    if(String(url).endsWith('/claim')) return response({item:{...claim,leaseExpiresAt:new Date(Date.now()+100).toISOString()}});
    if(String(url).endsWith('/heartbeat')) return response({},503);
    if(/\/(complete|fail|needs-attention)$/.test(String(url))) terminal=true;
    return response({});
  };
  await access(new ControlPlaneTaskPoller(cfg,async (_item,_report,signal)=> {
    await new Promise<void>((resolve,reject)=> {
      const timeout=setTimeout(()=>reject(Error('lease did not abort')),1000);
      signal.addEventListener('abort',()=>{clearTimeout(timeout);aborted=true;resolve();},{once:true});
    });
  },undefined,{leaseHeartbeatMs:10})).runOne(item);
  assert.equal(aborted,true,'abort at confirmed expiry even if heartbeats only fail transiently');
  assert.equal(terminal,false);

  let reservations=0;
  let agentCalls=0;
  let parked=false;
  globalThis.fetch = async url => {
    if(String(url).endsWith('/claim')) return response({item:{...claim,maxAttempts:3,leaseExpiresAt:new Date(Date.now()+10000).toISOString()}});
    if(String(url).endsWith('/attempt')) {reservations++;return response({item:{...claim,attempt:3}});}
    if(String(url).endsWith('/needs-attention')) parked=true;
    return response({});
  };
  await access(new ControlPlaneTaskPoller(cfg,async()=>{agentCalls++;throw Error('transient');},undefined,{
    policy:{decide:()=>({action:'retry',delayMs:0,condition:'transport_error',summary:'Retry'})},
  })).runOne(item);
  assert.equal(reservations,1);
  assert.equal(agentCalls,2,'durable attempt 2 leaves only one retry in budget 3');
  assert.equal(parked,true);
  console.log('✓ authoritative claim, durable result delivery/restart, lease deadline, server-reserved retry budget');
} finally {globalThis.fetch=original;rmSync(directory,{recursive:true,force:true});}
