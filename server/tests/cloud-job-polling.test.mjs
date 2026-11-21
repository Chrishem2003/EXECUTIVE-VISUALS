import test from "node:test";
import assert from "node:assert/strict";
import { cloudJobStatusPath, summarizeCloudJobProgress } from "../../src/platform/cloud-job-polling.ts";

test("routes Neon jobs to the owner-scoped Neon status endpoint", () => {
  assert.equal(
    cloudJobStatusPath("neon-postgres", "423e4567-e89b-42d3-a456-426614174000"),
    "/api/neon-staging/video-generation-jobs/423e4567-e89b-42d3-a456-426614174000"
  );
});

test("keeps existing cloud jobs on their original status endpoint", () => {
  assert.equal(
    cloudJobStatusPath("cloud", "job/with spaces"),
    "/api/cloud/jobs/job%2Fwith%20spaces"
  );
});

test("defaults historical records without a backend to the existing cloud endpoint", () => {
  assert.equal(cloudJobStatusPath(undefined, "legacy-job"), "/api/cloud/jobs/legacy-job");
});



test("summarizes completed, active, failed and cancelled generation jobs without hiding failures", () => {
  assert.equal(summarizeCloudJobProgress([
    { status: "succeeded" }, { status: "completed" },
    { status: "processing" }, { status: "failed" }, { status: "cancelled" }
  ]), "2 of 5 complete · 1 active · 1 failed · 1 cancelled");
});

test("summarizes an entirely active or empty generation batch", () => {
  assert.equal(summarizeCloudJobProgress([{ status: "queued" }, { status: "running" }]), "0 of 2 complete · 2 active");
  assert.equal(summarizeCloudJobProgress([]), "No generation jobs");
});
