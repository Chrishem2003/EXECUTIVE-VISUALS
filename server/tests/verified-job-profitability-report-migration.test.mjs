import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const sql=readFileSync(new URL("../../supabase/migrations/20261123190000_verified_job_profitability_report_batch_105.sql",import.meta.url),"utf8");
const netSql=readFileSync(new URL("../../supabase/migrations/20261123210000_net_job_contribution_payment_fees_batch_107.sql",import.meta.url),"utf8");

test("job profitability SQL is admin-only and read-only",()=>{
 assert.match(sql,/platform_admins[\s\S]*role in\('owner','platform_admin','billing_admin'\)/);
 assert.match(sql,/revoke all on function executive_visuals\.financial_job_profitability_report[\s\S]*grant execute[\s\S]*to service_role/i);
 assert.doesNotMatch(sql,/\b(insert into|update executive_visuals\.|delete from executive_visuals\.)/i);
});

test("job profitability withholds contribution unless revenue credits and provider invoice coverage reconcile",()=>{
 assert.match(sql,/credits_attributed<>actual_credits/);
 assert.match(sql,/credits_attributed=actual_credits/);
 assert.match(sql,/succeeded_usage_events<>invoice_line_count/);
 assert.match(sql,/revenue_currencies->>0\)=cost_currency/);
 assert.match(sql,/pending_subscription_split|unattributed/i);
});

test("job profitability keeps revenue and invoice costs currency-scoped",()=>{
 assert.match(sql,/count\(distinct a\.currency\)/);
 assert.match(sql,/count\(distinct c\.currency\)/);
 assert.match(sql,/currency_mismatch/);
 assert.match(sql,/grossMarginPct/);
});

test("net job contribution allocates only verified payment fees to consumed credit sources",()=>{
 assert.match(netSql,/provider_fee_minor/);
 assert.match(netSql,/payment_processor_fee_evidence/);
 assert.match(netSql,/record_payment_processor_fee_evidence/);
 assert.match(netSql,/PAYMENT_PROCESSOR_FEE_EVIDENCE_IS_APPEND_ONLY/);
 assert.match(netSql,/evidence_sha256/);

 assert.match(netSql,/cumulative_credits/);
 assert.match(netSql,/allocated_fee_minor/);
 assert.match(netSql,/missing_fee_count>0/);
 assert.match(netSql,/netContributionMinor/);
 assert.match(netSql,/netMarginPct/);
 assert.match(netSql,/processor_fee_incomplete/);
 assert.match(netSql,/source_consumed_total/);
 assert.match(netSql,/processor_fee_allocation_inconsistent/);
 assert.match(netSql,/rows between unbounded preceding and current row/i);
});
