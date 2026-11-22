import {readFile} from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

const root=new URL("../../",import.meta.url);
const migrationPath=new URL("supabase/migrations/20261122230000_verified_credit_revenue_allocation_batch_71.sql",root);
const integrationPath=new URL("scripts/verified-credit-revenue-allocation-postgres-integration-batch-71.sql",root);

test("Batch 71 revenue source requires verified payment and matching credit grant evidence",async()=>{
  const sql=await readFile(migrationPath,"utf8");
  assert.match(sql,/status='successful' and verified_at is not null/);
  assert.match(sql,/payment_transaction_id=payment_row\.id/);
  assert.match(sql,/entry_type='purchase_grant'/);
  assert.match(sql,/payment_purpose'<>'credit_pack_purchase'/);
  assert.match(sql,/credit_pack_applied/);
  assert.match(sql,/pending_subscription_split/);
  assert.match(sql,/non_revenue/);
});

test("Batch 71 allocates only settled credit consumption and is idempotent",async()=>{
  const sql=await readFile(migrationPath,"utf8");
  assert.match(sql,/where id=p_reservation_id and state='settled'/);
  assert.match(sql,/billing_credit_revenue_allocation_runs/);
  assert.match(sql,/reservation_id uuid primary key/);
  assert.match(sql,/idempotency_key text not null unique/);
  assert.match(sql,/order by s\.created_at,s\.id/);
  assert.match(sql,/floor\(/);
  assert.match(sql,/unattributed/);
  assert.match(sql,/pending_subscription_split/);
});

test("Batch 71 settlement and revenue allocation are atomic and service-role gated",async()=>{
  const sql=await readFile(migrationPath,"utf8");
  assert.match(sql,/rename to settle_generation_credit_reservation_pre_revenue_batch71/);
  assert.match(sql,/perform allocate_generation_credit_revenue_for_reservation\(p_reservation_id\)/);
  assert.match(sql,/revoke all on function executive_visuals\.settle_generation_credit_reservation/);
  assert.match(sql,/grant execute on function executive_visuals\.settle_generation_credit_reservation/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/revoke all on executive_visuals\.billing_credit_revenue_sources from public,anon,authenticated/);
});

test("Batch 71 reporting blocks gross margin when revenue, provider invoice or currency evidence is incomplete",async()=>{
  const sql=await readFile(migrationPath,"utf8");
  assert.match(sql,/get_verified_job_cost_coverage/);
  assert.match(sql,/matched_imports/);
  assert.match(sql,/revenue_allocation_incomplete/);
  assert.match(sql,/mixed_currency_cost_review/);
  assert.match(sql,/currency_mismatch_review/);
  assert.match(sql,/gross_margin_pct/);
  assert.match(sql,/profitabilityAvailable/);
  assert.match(sql,/payment processing fees, refunds, chargebacks, tax, storage, rendering/);
});

test("Batch 71 disposable PostgreSQL integration covers paid, subscription, promotional and replay cases",async()=>{
  const sql=await readFile(integrationPath,"utf8");
  for(const term of ["paid_credit_pack","subscription_allowance","promotional","idempotent","pending_subscription_split","Mismatched currency","settlement replay"])assert.ok(sql.includes(term),"missing integration case: "+term);
});

test("Financial Command Centre displays revenue and margin with subscription split limitations",async()=>{
  const app=await readFile(new URL("src/platform/app.ts",root),"utf8");
  assert.match(app,/Verified job revenue, cost & margin/);
  assert.match(app,/Recognized revenue/);
  assert.match(app,/Gross margin/);
  assert.match(app,/Subscription credit revenue remains unrecognized/);
});
