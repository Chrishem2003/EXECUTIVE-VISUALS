import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const root=new URL("../../",import.meta.url);
const [migration,baseWallet,revenueAllocation,manualRenewal,providerBilling,pricing]=await Promise.all([
 readFile(new URL("supabase/migrations/20261122240000_subscription_credit_wallet_bridge_batch_77.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261109230000_cloud_customer_credit_reservations.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261122230000_verified_credit_revenue_allocation_batch_71.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261110200000_subscription_manual_renewal.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261121120000_paddle_pesapal_provider_billing.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261122100000_subscription_pricing_hypotheses.sql",root),"utf8")
]);

test("Batch 71 remains the single payment-to-generation-wallet mirror and revenue-source registrar",()=>{
 assert.match(revenueAllocation,/create or replace function executive_visuals\.sync_verified_payment_credit_grant_to_generation_wallet/);
 assert.match(revenueAllocation,/payment-credit-ledger:/);
 assert.match(revenueAllocation,/register_generation_credit_revenue_source\(/);
 assert.match(revenueAllocation,/'subscription_allowance'/);
 assert.match(baseWallet,/create table if not exists executive_visuals\.billing_credit_ledger/);
 assert.doesNotMatch(migration,/create trigger[\s\S]*after insert on executive_visuals\.credit_ledger/i);
 assert.doesNotMatch(migration,/grant_generation_credits\(/);
});

test("legacy Flutterwave manual renewal events create the missing legacy subscription grant",()=>{
 assert.match(manualRenewal,/renewal_applied/);
 assert.doesNotMatch(manualRenewal,/subscription_applied/);
 assert.match(migration,/after insert on executive_visuals\.subscription_events/i);
 assert.match(migration,/new\.event_type not in \('activated','renewed'\)/);
 assert.match(migration,/new\.source not in \('flutterwave','paddle','pesapal'\)/);
 assert.match(migration,/SUBSCRIPTION_PERIOD_PAYMENT_NOT_VERIFIED/);
 assert.match(migration,/SUBSCRIPTION_PERIOD_PAYMENT_PURPOSE_MISMATCH/);
 assert.match(migration,/SUBSCRIPTION_PERIOD_CREDIT_GRANT_CONFLICT/);
 assert.match(migration,/subscription-purchase:/);
 assert.match(migration,/subscription-renewal:/);
 assert.match(migration,/subscription_row\.included_credits/);
});

test("legacy renewal marker is normalized only after verified payment and then existing Batch 71 trigger mirrors it",()=>{
 assert.match(migration,/renewal_applied/);
 assert.match(migration,/jsonb_build_object\('subscription_applied',true\)/);
 assert.match(migration,/SUBSCRIPTION_PERIOD_NOT_APPLIED/);
 assert.match(revenueAllocation,/payment_purpose' in\('subscription_purchase','subscription_renewal'\)/);
 assert.match(revenueAllocation,/payment_row\.metadata->>'subscription_applied'/);
});

test("existing Paddle and Pesapal finalizers remain payment authorities with their current grant idempotency keys",()=>{
 assert.match(providerBilling,/finalize_subscription_purchase_for_provider/);
 assert.match(providerBilling,/finalize_subscription_renewal_for_provider/);
 assert.match(providerBilling,/finalize_paddle_subscription_renewal/);
 assert.match(providerBilling,/subscription-purchase:/);
 assert.match(providerBilling,/subscription-renewal:/);
 assert.match(migration,/payment_row\.provider<>new\.source/);
});

test("forward-only bridge does not backfill historical balances or activate proposed pricing",()=>{
 assert.doesNotMatch(migration,/insert into executive_visuals\.subscription_plans/i);
 assert.doesNotMatch(migration,/update executive_visuals\.subscription_plans/i);
 assert.doesNotMatch(migration,/update executive_visuals\.billing_credit_ledger/i);
 assert.doesNotMatch(migration,/delete from executive_visuals\.billing_credit_ledger/i);
 assert.match(pricing,/'draft'/);
 assert.match(pricing,/'false,1/);
 assert.match(migration,/revoke all on function executive_visuals\.ensure_subscription_period_credit_grant\(\)/);
});
