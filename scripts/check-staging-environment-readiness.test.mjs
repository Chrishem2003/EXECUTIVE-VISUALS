import test from "node:test";
import assert from "node:assert/strict";
import { assessStagingConfig, APPROVED_STAGING_PROJECT_REF, stagingReadinessExitCode } from "./check-staging-environment-readiness.mjs";

const complete = () => ({
  SUPABASE_STAGING_URL: `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`,
  SUPABASE_STAGING_ANON_KEY: "test-anon-placeholder",
  SUPABASE_STAGING_SECRET_KEY: "test-server-placeholder",
  SUPABASE_STAGING_DB_URL: `postgresql://postgres:placeholder@db.${APPROVED_STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
  STORAGE_TEST_OWNER_EMAIL: "owner@example.test",
  STORAGE_TEST_OWNER_PASSWORD: "owner-test-password",
  STORAGE_TEST_OTHER_EMAIL: "other@example.test",
  STORAGE_TEST_OTHER_PASSWORD: "other-test-password",
  STORAGE_TEST_OWNER_ID: "123e4567-e89b-42d3-a456-426614174000",
  STAGING_BACKUP_ENCRYPTION_PASSPHRASE: "a-test-only-passphrase-with-32-chars",
  PADDLE_SANDBOX_API_KEY: "pdl_sdbx_test_placeholder",
  PADDLE_WEBHOOK_SECRET: "webhook-secret-test-placeholder",
  PESAPAL_SANDBOX_CONSUMER_KEY: "test-pesapal-key",
  PESAPAL_SANDBOX_CONSUMER_SECRET: "test-pesapal-secret",
  PESAPAL_IPN_ID: "223e4567-e89b-42d3-a456-426614174000",
  PESAPAL_CALLBACK_URL: "https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal",
  OPS_ALERT_WEBHOOK_URL: "https://alerts.example.test/webhook",
  EXECUTIVE_VISUALS_HEALTH_URL: "https://staging.example.test/api/health",
});

test("missing secrets are BLOCKED, and the strict launch gate fails closed without exposing values", () => {
  const report = assessStagingConfig({});
  assert.equal(report.state, "BLOCKED");
  assert.ok(report.missing.includes("SUPABASE_STAGING_URL"));
  assert.ok(report.missing.includes("STORAGE_TEST_OWNER_PASSWORD"));
  assert.ok(report.missing.includes("STORAGE_TEST_OTHER_PASSWORD"));
  assert.equal(report.credentialValuesExposed, false);
  assert.equal(JSON.stringify(report).includes("placeholder"), false);
  assert.equal(JSON.stringify(report).includes("owner-test-password"), false);
  assert.equal(stagingReadinessExitCode(report), 0, "report-only mode remains usable during setup");
  assert.equal(stagingReadinessExitCode(report, { requireReady: true }), 1, "launch gate must fail closed");
});

test("complete approved staging configuration is READY", () => {
  const report = assessStagingConfig(complete());
  assert.equal(report.state, "READY");
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.invalid, []);
});

test("rejects a production or unrelated Supabase project URL", () => {
  const env = complete();
  env.SUPABASE_STAGING_URL = "https://production-project.supabase.co";
  assert.ok(assessStagingConfig(env).invalid.includes("SUPABASE_STAGING_URL"));
});

test("rejects a database URL that does not identify the approved staging project", () => {
  const env = complete();
  env.SUPABASE_STAGING_DB_URL = "postgresql://postgres:placeholder@db.other-project.supabase.co:5432/postgres";
  assert.ok(assessStagingConfig(env).invalid.includes("SUPABASE_STAGING_DB_URL"));
});

test("rejects live Paddle keys and weak backup passphrases", () => {
  const env = complete();
  env.PADDLE_SANDBOX_API_KEY = "pdl_live_not-a-sandbox-key";
  env.STAGING_BACKUP_ENCRYPTION_PASSPHRASE = "short";
  const report = assessStagingConfig(env);
  assert.ok(report.invalid.includes("PADDLE_SANDBOX_API_KEY"));
  assert.ok(report.invalid.includes("STAGING_BACKUP_ENCRYPTION_PASSPHRASE"));
});

test("rejects non-HTTPS operational endpoints and malformed owner identity", () => {
  const env = complete();
  env.OPS_ALERT_WEBHOOK_URL = "http://insecure.example.test/hook";
  env.STORAGE_TEST_OWNER_ID = "not-a-uuid";
  const report = assessStagingConfig(env);
  assert.ok(report.invalid.includes("OPS_ALERT_WEBHOOK_URL"));
  assert.ok(report.invalid.includes("STORAGE_TEST_OWNER_ID"));
});

test("rejects a database URL with a forged project-scoped username on an unrelated host", () => {
  const env = complete();
  env.SUPABASE_STAGING_DB_URL = "postgresql://postgres.bokxljngydmqrmktofwm:placeholder@attacker.example:5432/postgres";
  assert.ok(assessStagingConfig(env).invalid.includes("SUPABASE_STAGING_DB_URL"));
});

test("requires a valid Paddle webhook secret and Pesapal IPN identity", () => {
  const env = complete();
  env.PADDLE_WEBHOOK_SECRET = "short";
  env.PESAPAL_IPN_ID = "not-a-uuid";
  const report = assessStagingConfig(env);
  assert.ok(report.invalid.includes("PADDLE_WEBHOOK_SECRET"));
  assert.ok(report.invalid.includes("PESAPAL_IPN_ID"));
});

test("requires the actual GET Pesapal IPN route on the staging callback URL", () => {
  const env = complete();
  assert.equal(assessStagingConfig(env).state, "READY");
  env.PESAPAL_CALLBACK_URL = "https://executive-visuals-cloud-staging.onrender.com/api/billing/pesapal/ipn";
  assert.ok(assessStagingConfig(env).invalid.includes("PESAPAL_CALLBACK_URL"));
  env.PESAPAL_CALLBACK_URL = "http://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal";
  assert.ok(assessStagingConfig(env).invalid.includes("PESAPAL_CALLBACK_URL"));
});

test("rejects a Pesapal IPN callback hosted outside the approved Render staging service", () => {
  const env = complete();
  env.PESAPAL_CALLBACK_URL = "https://attacker.example/api/webhooks/pesapal";
  assert.ok(assessStagingConfig(env).invalid.includes("PESAPAL_CALLBACK_URL"));
});

test("strict launch gate passes only for READY and always rejects INVALID", () => {
  const ready = assessStagingConfig(complete());
  assert.equal(stagingReadinessExitCode(ready, { requireReady: true }), 0);
  const invalidEnv = complete();
  invalidEnv.PADDLE_SANDBOX_API_KEY = "pdl_live_not-a-sandbox-key";
  const invalid = assessStagingConfig(invalidEnv);
  assert.equal(invalid.state, "INVALID");
  assert.equal(stagingReadinessExitCode(invalid), 1);
  assert.equal(stagingReadinessExitCode(invalid, { requireReady: true }), 1);
});
