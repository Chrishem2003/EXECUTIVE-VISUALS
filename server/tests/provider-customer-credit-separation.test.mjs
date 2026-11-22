import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const [migration, api, index, app, policy] = await Promise.all([
  readFile(new URL("supabase/migrations/20261122120000_provider_customer_credit_separation.sql", root), "utf8"),
  readFile(new URL("server/cloud-timeline-api.mjs", root), "utf8"),
  readFile(new URL("server/index.mjs", root), "utf8"),
  readFile(new URL("src/platform/app.ts", root), "utf8"),
  readFile(new URL("server/neon-customer-credit-policy.mjs", root), "utf8")
]);

test("cloud workflow quote schema stores provider credits and customer credits separately", () => {
  assert.match(migration, /add column if not exists estimated_customer_credits bigint/i);
  assert.match(migration, /record_video_workflow_quote_with_customer_credits/i);
  assert.match(migration, /set estimated_customer_credits=p_estimated_customer_credits/i);
  assert.match(migration, /quote_row\.estimated_customer_credits,\s*'video-workflow:'/);
  assert.match(migration, /cr\.reserved_credits=coalesce\(quote_row\.estimated_customer_credits,quote_row\.estimated_credits\)/);
});

test("legacy provider-only quotes cannot create a new customer-credit reservation", () => {
  assert.match(migration, /if quote_row\.estimated_customer_credits is null or quote_row\.estimated_customer_credits <= 0 then[\s\S]*VIDEO_WORKFLOW_CUSTOMER_CREDIT_PRICING_REQUIRED/);
});

test("cloud quote API computes customer credits server-side and calls the provider-compatible wrapper", () => {
  assert.match(api, /typeof quoteCustomerCredits!==\"function\"/);
  assert.match(api, /quoteCustomerCredits\(\{currency:\"USD\",amountMicros:providerCostMicros\}\)/);
  assert.match(api, /rpc\/record_video_workflow_quote_with_customer_credits/);
  assert.match(api, /estimatedProviderCredits:estimate\.estimatedCredits,estimatedCustomerCredits/);
  assert.match(index, /createCustomerCreditQuotePolicy/);
  assert.match(index, /CUSTOMER_CREDITS_PER_USD/);
});

test("customer credit conversion reuses shared cost-plus margin and fee economics", () => {
  assert.match(policy, /priceWorkloadCostUnits\(amountMicros, pricing\)/);
  assert.match(policy, /targetMarginBps/);
  assert.match(policy, /paymentFeeBps/);
  assert.match(policy, /supportReserveBps/);
});

test("billing workspace shows available, reserved and total customer credits", () => {
  assert.match(app, /\/api\/billing\/credits/);
  assert.match(app, /Available to use/);
  assert.match(app, /Reserved for jobs/);
  assert.match(app, /Total ledger balance/);
  assert.match(app, /separate from provider billing credits/);
});

test("storyboard preflight requires a configured customer quote before approval", () => {
  assert.match(index, /Customer credit pricing is not configured\. No approval or paid submission is allowed\./);
  assert.match(index, /Per-shot customer credit quote is outside safe bounds/);
  assert.match(app, /Estimated customer credits:/);
});
