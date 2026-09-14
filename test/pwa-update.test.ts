import assert from "node:assert/strict";
import { activateWaitingWorker } from "../packages/web/src/pwaUpdate.js";

class Worker extends EventTarget {
  state: ServiceWorkerState = "installed";
  messages: unknown[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
  get registration() { return { waiting: this as unknown as ServiceWorker }; }
}

// A stale prompt (another tab activated the update) must resolve so the caller
// can reload, rather than silently waiting for a controllerchange that never comes.
await activateWaitingWorker({ waiting: null });
await activateWaitingWorker(undefined);

const worker = new Worker();
let completed = false;
const activation = activateWaitingWorker(worker.registration).then(() => { completed = true; });
assert.deepEqual(worker.messages, [{ type: "SKIP_WAITING" }]);
worker.transition("activating");
await Promise.resolve();
assert.equal(completed, false, "do not reload before precache activation finishes");
worker.transition("activated");
await activation;
assert.equal(completed, true);
await activateWaitingWorker(worker.registration);
assert.equal(worker.messages.length, 1, "already-activated workers need no message");

const replaced = new Worker();
const replacement = activateWaitingWorker(replaced.registration);
replaced.transition("redundant");
await assert.rejects(replacement, /replaced/);

const stuck = new Worker();
await assert.rejects(activateWaitingWorker(stuck.registration, 1), /did not activate/);
// A timeout must leave the operation retryable.
const retry = activateWaitingWorker(stuck.registration);
stuck.transition("activated");
await retry;

const broken = new Worker();
broken.postMessage = () => { throw new Error("message failed"); };
await assert.rejects(activateWaitingWorker(broken.registration), /message failed/);
console.log("pwa-update: ok");
