import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleInteractionRetentionPolicy } from "../google-interaction-retention-policy.mjs";

test("requires explicit paid-tier confirmation and an exact supported AI Studio retention value", () => {
  for (const value of [undefined, "", "1", "6", "8", "30", "56", "7.0", "07"]) {
    assert.throws(
      () => createGoogleInteractionRetentionPolicy({
        env: { GEMINI_OMNI_PAID_TIER_CONFIRMED: "true", GEMINI_OMNI_RETENTION_DAYS: value }
      }),
      error => error.code === "GEMINI_OMNI_RETENTION_POLICY_REQUIRED"
    );
  }
  assert.throws(
    () => createGoogleInteractionRetentionPolicy({
      env: { GEMINI_OMNI_RETENTION_DAYS: "28" }
    }),
    error => error.code === "GEMINI_OMNI_RETENTION_POLICY_REQUIRED"
  );
});

test("computes expiry from the provider submission timestamp", async () => {
  const policy = createGoogleInteractionRetentionPolicy({
    env: { GEMINI_OMNI_PAID_TIER_CONFIRMED: "true", GEMINI_OMNI_RETENTION_DAYS: "28" },
    now: () => Date.parse("2026-11-05T00:00:00.000Z")
  });
  assert.equal(policy.retentionDays, 28);
  assert.equal(await policy.expiresAt({ submittedAt: "2026-11-05T12:30:00.000Z" }),
    "2026-12-03T12:30:00.000Z");
});

test("supports only the documented paid-tier AI Studio options", () => {
  for (const days of [7, 14, 28, 55]) {
    const policy = createGoogleInteractionRetentionPolicy({
      env: { GEMINI_OMNI_PAID_TIER_CONFIRMED: "true", GEMINI_OMNI_RETENTION_DAYS: String(days) }
    });
    assert.equal(policy.retentionDays, days);
  }
});

test("rejects invalid submission timestamps", async () => {
  const policy = createGoogleInteractionRetentionPolicy({
    env: { GEMINI_OMNI_PAID_TIER_CONFIRMED: "true", GEMINI_OMNI_RETENTION_DAYS: "7" }
  });
  await assert.rejects(() => policy.expiresAt({ submittedAt: "not-a-date" }),
    error => error.code === "GEMINI_OMNI_RETENTION_TIMESTAMP_INVALID");
});
