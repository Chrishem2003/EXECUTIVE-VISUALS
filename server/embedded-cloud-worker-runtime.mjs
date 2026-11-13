import { startCloudWorkerProcess } from "./cloud-worker-process.mjs";

/**
 * Optional same-container cloud video worker for low-cost web-service hosting.
 * It is disabled by default and deliberately excludes media/timeline workers,
 * which can compete with the API for CPU and memory.
 */
export async function startEmbeddedCloudWorker({
  env = process.env,
  start = startCloudWorkerProcess
} = {}) {
  if (env.CLOUD_WORKER_IN_PROCESS_ENABLED !== "true") return null;
  if (env.CLOUD_WORKER_ENABLED !== "true" || env.CLOUD_VIDEO_WORKER_ENABLED !== "true") {
    throw new Error("Embedded cloud execution requires CLOUD_WORKER_ENABLED=true and CLOUD_VIDEO_WORKER_ENABLED=true.");
  }
  if (env.CLOUD_MEDIA_WORKER_ENABLED === "true" || env.CLOUD_TIMELINE_WORKER_ENABLED === "true") {
    throw new Error("Embedded mode supports only the remote video worker; media and timeline workers must remain separate.");
  }
  if (typeof start !== "function") throw new TypeError("Embedded cloud worker starter must be a function.");

  const supervisor = await start();
  if (!supervisor || typeof supervisor.stop !== "function") {
    throw new Error("Cloud worker startup did not return a stoppable supervisor.");
  }
  return Object.freeze({
    active: true,
    async stop() {
      await supervisor.stop();
    }
  });
}
