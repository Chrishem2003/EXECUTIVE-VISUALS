import { runExecutiveVisualsMonitoring } from "../server/ops-monitoring.mjs";

const result = await runExecutiveVisualsMonitoring({
  testAlert: process.argv.includes("--test-alert")
});
console.log(JSON.stringify(result));
if (result.exitCode) process.exitCode = result.exitCode;
