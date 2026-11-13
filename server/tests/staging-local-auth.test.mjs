import test from "node:test";
import assert from "node:assert/strict";
import { getStagingLocalAuthPolicy, isStagingLocalAuthEmailAllowed } from "../staging-local-auth.mjs";

const valid = {
  NODE_ENV: "production",
  AUTH_MODE: "local",
  STAGING_LOCAL_AUTH_ENABLED: "true",
  STAGING_LOCAL_AUTH_ORIGIN: "https://executive-visuals-1.onrender.com",
  D1_STAGING_WORKER_URL: "https://executive-visuals-d1-staging.chrishem.workers.dev",
  STAGING_LOCAL_AUTH_ALLOWLIST: "EV-Staging-Smoke@example.com"
};

test("staging local auth is disabled by default", () => {
  assert.equal(getStagingLocalAuthPolicy({}).enabled, false);
});

test("staging local auth enables only with the exact isolated staging origin and Worker", () => {
  const policy = getStagingLocalAuthPolicy(valid);
  assert.equal(policy.enabled, true);
  assert.equal(policy.origin, valid.STAGING_LOCAL_AUTH_ORIGIN);
  assert.deepEqual(policy.allowlist, ["ev-staging-smoke@example.com"]);
});

test("production origin cannot enable the staging local-auth exception", () => {
  assert.equal(getStagingLocalAuthPolicy({
    ...valid,
    STAGING_LOCAL_AUTH_ORIGIN: "https://executive-visuals.onrender.com"
  }).enabled, false);
});

test("a different Cloudflare Worker cannot enable the staging local-auth exception", () => {
  assert.equal(getStagingLocalAuthPolicy({
    ...valid,
    D1_STAGING_WORKER_URL: "https://another-worker.example.workers.dev"
  }).enabled, false);
});

test("local auth mode and explicit staging flag are both required", () => {
  assert.equal(getStagingLocalAuthPolicy({ ...valid, AUTH_MODE: "supabase" }).enabled, false);
  assert.equal(getStagingLocalAuthPolicy({ ...valid, STAGING_LOCAL_AUTH_ENABLED: "false" }).enabled, false);
});

test("an empty or invalid email allowlist fails closed", () => {
  assert.equal(getStagingLocalAuthPolicy({ ...valid, STAGING_LOCAL_AUTH_ALLOWLIST: "" }).enabled, false);
  assert.equal(getStagingLocalAuthPolicy({ ...valid, STAGING_LOCAL_AUTH_ALLOWLIST: "not-an-email" }).enabled, false);
});

test("registration and login are limited to normalized allowlisted email addresses", () => {
  const policy = getStagingLocalAuthPolicy(valid);
  assert.equal(isStagingLocalAuthEmailAllowed(policy, " EV-STAGING-SMOKE@EXAMPLE.COM "), true);
  assert.equal(isStagingLocalAuthEmailAllowed(policy, "other@example.com"), false);
  assert.equal(isStagingLocalAuthEmailAllowed(getStagingLocalAuthPolicy({}), "ev-staging-smoke@example.com"), false);
});
