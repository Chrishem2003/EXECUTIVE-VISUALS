import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../supabase/migrations/20261123100000_workflow_node_customer_credit_ceiling_batch_89.sql", import.meta.url), "utf8");
const api = await readFile(new URL("../cloud-timeline-api.mjs", import.meta.url), "utf8");
const ui = await readFile(new URL("../../src/platform/workflow-workspace.ts", import.meta.url), "utf8");

test("workflow approval RPC requires both the customer ceiling and server-priced reservation", () => {
  assert.match(migration, /p_customer_credit_budget_credits bigint/);
  assert.match(migration, /p_required_customer_credits bigint/);
  assert.match(migration, /p_customer_credit_budget_credits < p_required_customer_credits/);
  assert.match(migration, /p_required_customer_credits < quote_row\.estimated_customer_credits/);
  assert.match(migration, /reserve_generation_credits\([\s\S]*p_required_customer_credits/);
  assert.match(migration, /revoke all on function executive_visuals\.approve_and_enqueue_video_workflow\([^;]+bigint,bigint\)[\s\S]*from public,anon,authenticated/);
  assert.match(migration, /revoke all on function executive_visuals\.approve_and_enqueue_video_workflow\([^;]+numeric,text\)[\s\S]*from public,anon,authenticated,service_role/);
});

test("server validates customer credits from the approved USD ceiling and passes both values to the atomic RPC", () => {
  assert.match(api, /quoteCustomerCredits\(\{currency:"USD",amountMicros:approvedMaxAmountMicros\}\)/);
  assert.match(api, /customerCreditBudgetCredits<requiredCustomerCredits/);
  assert.match(api, /p_customer_credit_budget_credits:customerCreditBudgetCredits/);
  assert.match(api, /p_required_customer_credits:requiredCustomerCredits/);
});

test("Video Studio asks the project owner to approve a separate customer-credit ceiling", () => {
  assert.match(ui, /wf-approved-credit-budget/);
  assert.match(ui, /customerCreditBudgetCredits/);
  assert.match(ui, /estimatedCustomerCredits/);
  assert.match(ui, /A higher USD ceiling may require more credits/);
});
