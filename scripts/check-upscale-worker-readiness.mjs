import { inspectUpscaleWorkerReadiness } from "../server/upscale-worker-readiness.mjs";

const report = await inspectUpscaleWorkerReadiness();
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!report.readyForQueuedUpscale) process.exitCode = 2;
