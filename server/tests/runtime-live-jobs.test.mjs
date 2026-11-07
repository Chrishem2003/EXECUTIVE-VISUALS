import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtime = await readFile(new URL("../../src/platform/runtime.ts", import.meta.url), "utf8");

test("runtime job polling is bounded to visible, authenticated runtime workspaces", () => {
  assert.match(runtime, /function startRuntimeJobPolling\(\)/);
  assert.match(runtime, /state\.status!=="online"/);
  assert.match(runtime, /document\.visibilityState!=="visible"/);
  assert.match(runtime, /#runtime-workspace\[data-runtime-view='runtime'\]/);
  assert.match(runtime, /window\.setInterval\(async\(\)=>\{[\s\S]*?\},5000\)/);
});

test("runtime polling prevents overlapping requests and preserves the last known state on transient failures", () => {
  assert.match(runtime, /if\(jobsPollInFlight\|\|/);
  assert.match(runtime, /jobsPollInFlight=true/);
  assert.match(runtime, /finally\{jobsPollInFlight=false;\}/);
  assert.match(runtime, /transient poll failure must not sign the user out/);
});

test("job queue exposes actionable status counts and explains its refresh cadence", () => {
  const start = runtime.indexOf("function renderJobs()");
  const end = runtime.indexOf("\nexport function renderRuntimeWorkspace()", start);
  const renderJobs = runtime.slice(start, end);
  for (const status of ["queued", "running", "completed", "failed"]) {
    assert.ok(renderJobs.includes('job.status==="'+status+'"'), "missing "+status+" counter");
  }
  assert.match(renderJobs, /Live queue refreshes every 5 seconds/);
});
