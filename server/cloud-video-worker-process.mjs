/**
 * Long-lived, single-flight process loop for a durable video worker.
 *
 * The web request process should not own this loop by default. A dedicated
 * worker process may opt in after staging database, storage, provider and
 * authorization gates have been independently verified.
 */
export function createCloudVideoWorkerProcess({
  worker,
  idlePollMs = 1500,
  activePollMs = 100,
  recoveryIntervalMs = 60_000,
  recoveryLimit = 100,
  initialErrorBackoffMs = 1000,
  maxErrorBackoffMs = 30_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  onEvent = () => {}
} = {}) {
  if (!worker || typeof worker.runCycle !== "function" || typeof worker.recoverExpired !== "function") {
    throw new Error("Video worker process requires runCycle and recoverExpired operations.");
  }
  for (const [name, value, min, max] of [
    ["idlePollMs", idlePollMs, 10, 60_000],
    ["activePollMs", activePollMs, 10, 10_000],
    ["recoveryIntervalMs", recoveryIntervalMs, 1000, 86_400_000],
    ["recoveryLimit", recoveryLimit, 1, 1000],
    ["initialErrorBackoffMs", initialErrorBackoffMs, 10, 60_000],
    ["maxErrorBackoffMs", maxErrorBackoffMs, initialErrorBackoffMs, 300_000]
  ]) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error("Video worker process " + name + " is outside its supported bounds.");
    }
  }
  if (typeof sleep !== "function" || typeof now !== "function" || typeof onEvent !== "function") {
    throw new Error("Video worker process clock, sleep and event handlers must be functions.");
  }

  let running = false;
  let loopPromise = null;
  let stopRequested = false;
  let wakeSleep = null;
  let cycles = 0;
  let failures = 0;
  let nextRecoveryAt = 0;
  let recovered = 0;
  let claimed = 0;
  let finished = 0;
  let lastCycleAt = null;
  let lastRecoveryAt = null;
  let lastErrorCode = null;

  function emit(type, details = {}) {
    try { onEvent(Object.freeze({ type, at: new Date(now()).toISOString(), ...details })); } catch {}
  }

  async function wait(ms) {
    if (!running || ms <= 0) return;
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        wakeSleep = null;
        resolve();
      };
      wakeSleep = finish;
      Promise.resolve().then(() => sleep(ms)).then(finish, finish);
    });
  }

  async function run() {
    let backoff = initialErrorBackoffMs;
    while (running) {
      if (now() >= nextRecoveryAt) {
        try {
          const recoveredCount = await worker.recoverExpired(recoveryLimit);
          recovered += Number.isSafeInteger(recoveredCount) && recoveredCount > 0 ? recoveredCount : 0;
          lastRecoveryAt = new Date(now()).toISOString();
          lastErrorCode = null;
          nextRecoveryAt = now() + recoveryIntervalMs;
          emit("video.worker.recovery_completed", { recovered: Number(recoveredCount) || 0 });
        } catch (error) {
          failures += 1;
          emit("video.worker.recovery_failed", {
            code: typeof error?.code === "string" ? error.code.slice(0, 80) : "WORKER_RECOVERY_FAILED"
          });
          nextRecoveryAt = now() + Math.min(backoff, recoveryIntervalMs);
          await wait(backoff);
          backoff = Math.min(backoff * 2, maxErrorBackoffMs);
          continue;
        }
      }
      if (!running) break;
      try {
        const result = await worker.runCycle();
        cycles += 1;
        lastCycleAt = new Date(now()).toISOString();
        if (result?.claimed === true) claimed += 1;
        if (result?.finished === true) finished += 1;
        failures = 0;
        lastErrorCode = null;
        backoff = initialErrorBackoffMs;
        emit("video.worker.cycle_completed", {
          claimed: result?.claimed === true,
          finished: result?.finished === true,
          status: typeof result?.status === "string" ? result.status : null
        });
        await wait(result?.claimed === true ? activePollMs : idlePollMs);
      } catch (error) {
        failures += 1;
        emit("video.worker.cycle_failed", {
          code: typeof error?.code === "string" ? error.code.slice(0, 80) : "WORKER_CYCLE_FAILED",
          failures
        });
        await wait(backoff);
        backoff = Math.min(backoff * 2, maxErrorBackoffMs);
      }
    }
  }

  function start() {
    if (running) return Object.freeze({ started: false, reason: "already_running" });
    running = true;
    stopRequested = false;
    nextRecoveryAt = 0;
    loopPromise = run().finally(() => { running = false; loopPromise = null; });
    emit("video.worker.started");
    return Object.freeze({ started: true });
  }

  async function stop() {
    if (!running && !loopPromise) return Object.freeze({ stopped: true, cycles, failures });
    stopRequested = true;
    running = false;
    if (wakeSleep) wakeSleep();
    const active = loopPromise;
    if (active) await active;
    emit("video.worker.stopped", { cycles, failures, stopRequested });
    return Object.freeze({ stopped: true, cycles, failures });
  }

  return Object.freeze({
    start,
    stop,
    status: () => Object.freeze({
      running, cycles, claimed, finished, recovered, failures, stopRequested,
      lastCycleAt, lastRecoveryAt, lastErrorCode
    })
  });
}
