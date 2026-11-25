import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../../src/platform/app.ts", import.meta.url), "utf8");

test("finance workspace loads the platform-owner margin policy through the owner-only API", () => {
  assert.match(app, /platformMarginPolicy:FinanceDashboard\|null/);
  assert.match(app, /\/api\/admin\/finance\/platform-video-margin-policy/);
  assert.match(app, /platformMarginPolicy=platformMarginPolicy\|\|null/);
});

test("owner console exposes versioned policy settings without inventing a default margin", () => {
  assert.match(app, /id="platform-margin-policy-form"/);
  assert.match(app, /name="minimumGrossMarginBps" type="number" min="1" max="9500"/);
  assert.match(app, /name="quoteMaxAgeSeconds" type="number" min="60" max="3600"/);
  assert.match(app, /name="rateCardMaxAgeSeconds" type="number" min="3600" max="3888000"/);
  assert.match(app, /minimum_gross_margin_bps\?\?''/);
  assert.match(app, /Immutable policy history/);
});

test("saving a policy uses a fresh idempotency key and does not claim to enable dispatch", () => {
  assert.match(app, /"idempotency-key":uid\(\)/);
  assert.match(app, /does not enable provider dispatch/);
  assert.match(app, /fully-loaded variable-cost model/);
  assert.match(app, /blocked_until_fully_loaded_cost_model_adapter/);
});
