import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration=readFileSync(new URL("../../supabase/migrations/20261123230000_verified_credit_liability_report_batch_111.sql",import.meta.url),"utf8");

test("credit liability report is restricted to finance administrators",()=>{
 assert.match(migration,/platform_admins[\s\S]*role in\('owner','platform_admin','billing_admin'\)/);
 assert.match(migration,/revoke all on function executive_visuals\.financial_credit_liability_report\(uuid,uuid\) from public,anon,authenticated/);
 assert.match(migration,/grant execute on function executive_visuals\.financial_credit_liability_report\(uuid,uuid\) to service_role/);
});

test("deferred revenue is derived only from verified paid-credit source allocations",()=>{
 assert.match(migration,/revenue_status='verified'[\s\S]*allocatable_revenue_minor-coalesce\(a\.recognized_revenue_minor,0\)/);
 assert.match(migration,/allocation_status='verified'/);
 assert.match(migration,/deferred_revenue_liability_minor/);
 assert.match(migration,/currency_mismatch_rows/);
});

test("unapproved subscription splits and unattributed credits stay outside currency liability",()=>{
 assert.match(migration,/pending_subscription_split_credits/);
 assert.match(migration,/unattributed_credits/);
 assert.match(migration,/pending_subscription_split/);
 assert.match(migration,/unattributed/);
 assert.match(migration,/Subscription allowance value awaiting an approved revenue split is reported as pending credits/);
});

test("integrity exceptions withhold currency liability instead of overstating it",()=>{
 assert.match(migration,/integrity_exception/);
 assert.match(migration,/when count\(\*\) filter\(where integrity_exception\)>0 then null/);
 assert.match(migration,/recognized_revenue_minor\)>s\.allocatable_revenue_minor/);
 assert.match(migration,/consumed_credits\)>s\.credits_granted/);
});

test("report is read-only and keeps cash, refunds, fees and MRR separate",()=>{
 assert.match(migration,/This report is read-only/);
 assert.match(migration,/Cash receipts, processor fees, refunds, tax and subscription MRR are reported in their own finance reports/);
 assert.doesNotMatch(migration,/insert into executive_visuals\.(billing_credit_ledger|payment_transactions|customer_subscriptions)/i);
});
