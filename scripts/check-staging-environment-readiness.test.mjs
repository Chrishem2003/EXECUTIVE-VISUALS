import test from "node:test";
import assert from "node:assert/strict";
import { assessStagingConfig, APPROVED_STAGING_PROJECT_REF } from "./check-staging-environment-readiness.mjs";

const complete = () => ({
  SUPABASE_STAGING_URL: `https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`,
  SUPABASE_STAGING_ANON_KEY: "test-anon-placeholder",
  SUPABASE_STAGING_SECRET_KEY: "test-server-placeholder",
  SUPABASE_STAGING_DB_URL: `postgresql://postgres:placeholder@db.${APPROVED_STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
  STORAGE_TEST_OWNER_JWT: "test-owner-jwt-placeholder",
  STORAGE_TEST_OTHER_JWT: "test-other-jwt-placeholder",
  STORAGE_TEST_OWNER_ID: "123e4567-e89b-42d3-a456-426614174000",
  STAGING_BACKUP_ENCRYPTION_PASSPHRASE: "a-test-only-passphrase-with-32-chars",
  PADDLE_SANDBOX_API_KEY: "pdl_sdbx_test_placeholder",
  PESAPAL_SANDBOX_CONSUMER_KEY: "test-pesapal-key",
  PESAPAL_SANDBOX_CONSUMER_SECRET: "test-pesapal-secret",
  OPS_ALERT_WEBHOOK_URL: "https://alerts.example.test/webhook",
  EXECUTIVE_VISUALS_HEALTH_URL: "https://staging.example.test/api/health",
});

test("missing secrets are reported as BLOCKED without failing or exposing values", () => {
  const report = assessStagingConfig({});
  assert.equal(report.state, "BLOCKED");
  assert.ok(report.missing.includes("SUPABASE_STAGING_URL"));
  assert.equal(report.credentialValuesExposed, false);
  assert.equal(JSON.stringify(report).includes("placeholder"), false);
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
