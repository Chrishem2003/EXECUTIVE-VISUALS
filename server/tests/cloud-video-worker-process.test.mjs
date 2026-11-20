import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoWorkerProcess } from "../cloud-video-worker-process.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("worker process runs recovery before polling and prevents duplicate starts", async () => {
  const calls = [];
  let releaseSleep;
  const process = createCloudVideoWorkerProcess({
    worker: {
      async recoverExpired(limit) { calls.push(["recover", limit]); return 3; },
      async runCycle() { calls.push(["cycle"]); return { claimed: false }; }
    },
    idlePollMs: 100,
    recoveryIntervalMs: 1000,
    sleep: () => new Promise(resolve => { releaseSleep = resolve; })
  });
  assert.deepEqual(process.start(), { started: true });
  assert.deepEqual(process.start(), { started: false, reason: "already_running" });
  await tick();
  assert.deepEqual(calls.slice(0, 2), [["recover", 100], ["cycle"]]);
  assert.equal(process.status().running, true);
  assert.equal(process.status().recovered, 3);
  assert.equal(process.status().cycles, 1);
  assert.equal(process.status().lastRecoveryAt !== null, true);
  assert.equal(process.status().lastCycleAt !== null, true);
  const stopping = process.stop();
  await stopping;
  assert.equal(process.status().running, false);
  assert.equal(calls.filter(x => x[0] === "cycle").length, 1);
  releaseSleep?.();
});

test("worker process drains an in-flight cycle before graceful stop completes", async () => {
  let finishCycle;
  let cycles = 0;
  const process = createCloudVideoWorkerProcess({
    worker: {
      async recoverExpired() { return 0; },
      async runCycle() {
        cycles += 1;
        return new Promise(resolve => { finishCycle = resolve; });
      }
    },
    sleep: async () => {},
    recoveryIntervalMs: 1000
  });
  process.start();
  await tick();
  const stopping = process.stop();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false);
  finishCycle({ claimed: true, finished: true });
  const result = await stopping;
  assert.equal(result.stopped, true);
  assert.equal(cycles, 1);
});

test("worker process backs off after a cycle error and sanitizes event codes", async () => {
  const waits = [];
  const events = [];
  let attempts = 0;
  let wake;
  const process = createCloudVideoWorkerProcess({
    worker: {
      async recoverExpired() { return 0; },
      async runCycle() { attempts += 1; throw Object.assign(new Error("secret details"), { code: "PROVIDER_TIMEOUT" }); }
    },
    initialErrorBackoffMs: 10,
    maxErrorBackoffMs: 20,
    recoveryIntervalMs: 1000,
    sleep: ms => { waits.push(ms); return new Promise(resolve => { wake = resolve; }); },
    onEvent: event => events.push(event)
  });
  process.start();
  await tick();
  assert.equal(attempts, 1);
  assert.deepEqual(waits, [10]);
  assert.equal(events.find(event => event.type === "video.worker.cycle_failed").code, "PROVIDER_TIMEOUT");
  assert.equal(process.status().lastErrorCode, "PROVIDER_TIMEOUT");
  assert.equal(process.status().failures, 1);
  assert.equal(JSON.stringify(events).includes("secret details"), false);
  const stopping = process.stop();
  await stopping;
});

test("worker process rejects unsafe polling and recovery bounds", () => {
  const worker = { async runCycle() {}, async recoverExpired() {} };
  assert.throws(() => createCloudVideoWorkerProcess({ worker, idlePollMs: 0 }), /idlePollMs/);
  assert.throws(() => createCloudVideoWorkerProcess({ worker, recoveryLimit: 1001 }), /recoveryLimit/);
  assert.throws(() => createCloudVideoWorkerProcess({ worker, maxErrorBackoffMs: 5 }), /maxErrorBackoffMs/);
});
