import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../supabase/migrations/20261122100000_subscription_pricing_hypotheses.sql", import.meta.url), "utf8");

test("proposed creator tiers are seeded as private draft hypotheses with no included credits", () => {
  for (const [code, name, amount] of [
    ["starter_creator", "Starter Creator", 900],
    ["professional_creator", "Professional Creator", 2900],
    ["studio", "Studio", 7900],
    ["agency", "Agency", 19900],
    ["enterprise", "Enterprise", 0]
  ]) {
    assert.match(migration, new RegExp("'" + code + "'"));
    assert.match(migration, new RegExp("'" + name + "'"));
    assert.match(migration, new RegExp("'draft'\\s*,\\s*'monthly'\\s*,\\s*" + amount + "\\s*,\\s*'USD'\\s*,\\s*0"));
  }
  assert.match(migration, /'pricing_hypothesis'/);
  assert.match(migration, /'credits_pending_cost_validation'/);
});

test("pricing hypotheses cannot be publicly purchased or silently overwrite existing plans", () => {
  assert.match(migration, /false,1/);
  assert.match(migration, /on conflict \\(plan_code\\) do nothing/i);
  assert.doesNotMatch(migration, /subscription_plan_provider_prices/i);
  assert.doesNotMatch(migration, /included_credits[^\n]*[1-9]/i);
});
