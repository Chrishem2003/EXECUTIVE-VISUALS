import test from "node:test";
import assert from "node:assert/strict";
import { isWorkflowQuoteExpired } from "../../src/core/workflow-quote-expiry.mjs";

test("future quote expiry remains approvable", () => {
  assert.equal(isWorkflowQuoteExpired("2026-11-19T12:00:00.000Z", Date.parse("2026-11-18T12:00:00.000Z")), false);
});
test("expired, missing and malformed quote expiry fail closed", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  assert.equal(isWorkflowQuoteExpired("2026-11-18T11:59:59.000Z", now), true);
  assert.equal(isWorkflowQuoteExpired("", now), true);
  assert.equal(isWorkflowQuoteExpired("not-a-date", now), true);
});
test("quote expiring at the current instant is expired", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  assert.equal(isWorkflowQuoteExpired("2026-11-18T12:00:00.000Z", now), true);
});
