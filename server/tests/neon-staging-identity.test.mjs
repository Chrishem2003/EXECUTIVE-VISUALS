import test from "node:test";
import assert from "node:assert/strict";
import { resolveNeonStagingIdentity } from "../neon-staging-identity.mjs";

const base = {
  NEON_STAGING_BRANCH_NAME: "staging",
  NEON_STAGING_PROJECT_ID: "hidden-boat-85273783",
  NEON_STAGING_BRANCH_ID: "br-rapid-cherry-bemy096c",
  NEON_STAGING_ENDPOINT_ID: "ep-floral-bird-bew4kq75",
  NEON_STAGING_DATABASE_NAME: "executive_visuals",
  NEON_DATABASE_URL: "postgresql://app:secret@ep-floral-bird-bew4kq75-pooler.c-9.us-east-2.aws.neon.tech/executive_visuals?sslmode=require"
};

test("accepts the actual isolated Neon staging branch and endpoint identity", () => {
  assert.deepEqual(resolveNeonStagingIdentity({ env: base, requireEndpointBinding: true }), {
    branchName: "staging",
    projectId: "hidden-boat-85273783",
    branchId: "br-rapid-cherry-bemy096c",
    endpointId: "ep-floral-bird-bew4kq75",
    databaseName: "executive_visuals"
  });
});

test("rejects a pooled connection URL pointing at another endpoint", () => {
  assert.throws(() => resolveNeonStagingIdentity({
    env: { ...base, NEON_DATABASE_URL: base.NEON_DATABASE_URL.replace("ep-floral-bird-bew4kq75", "ep-production-00000000") },
    requireEndpointBinding: true
  }), /does not match NEON_STAGING_ENDPOINT_ID/);
});

test("rejects a connection URL for another database", () => {
  assert.throws(() => resolveNeonStagingIdentity({
    env: { ...base, NEON_DATABASE_URL: base.NEON_DATABASE_URL.replace("/executive_visuals?", "/neondb?") },
    requireEndpointBinding: true
  }), /does not match NEON_STAGING_DATABASE_NAME/);
});

test("rejects direct rather than pooled application traffic", () => {
  assert.throws(() => resolveNeonStagingIdentity({
    env: { ...base, NEON_DATABASE_URL: base.NEON_DATABASE_URL.replace("-pooler", "") },
    requireEndpointBinding: true
  }), /must use the pooled endpoint/);
});

test("rejects unapproved branch labels", () => {
  assert.throws(() => resolveNeonStagingIdentity({
    env: { ...base, NEON_STAGING_BRANCH_NAME: "production" }
  }), /approved staging branch name/);
});
