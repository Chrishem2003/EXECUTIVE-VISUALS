import test from "node:test";
import assert from "node:assert/strict";
import { cloudJobStatusPath } from "../../src/platform/cloud-job-polling.ts";

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
