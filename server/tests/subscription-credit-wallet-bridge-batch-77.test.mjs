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

test("verified subscription grants bridge atomically into the actual generation wallet",()=>{
 assert.match(migration,/after insert on executive_visuals\.credit_ledger/i);
 assert.match(migration,/new\.entry_type<>'purchase_grant'/);
 assert.match(migration,/payment_row\.status<>'successful'/);
 assert.match(migration,/payment_row\.verified_at is null/);
 assert.match(migration,/payment_purpose' not in \('subscription_purchase','subscription_renewal'\)/);
 assert.match(migration,/subscription_applied/);
 assert.match(migration,/grant_generation_credits\(/);
 assert.match(migration,/register_generation_credit_revenue_source\(/);
 assert.match(migration,/'subscription_allowance'/);
 assert.match(baseWallet,/create table if not exists executive_visuals\.billing_credit_ledger/);
});

test("subscription wallet bridge preserves source payment, provider, period and immutable idempotency evidence",()=>{
 assert.match(migration,/subscription-generation-grant:/);
 assert.match(migration,/sourceLedgerId/);
 assert.match(migration,/paymentId/);
 assert.match(migration,/subscriptionId/);
 assert.match(migration,/verifiedAt/);
 assert.match(migration,/periodStart/);
 assert.match(migration,/periodEnd/);
 assert.match(revenueAllocation,/source_type='subscription_allowance'/);
 assert.match(revenueAllocation,/pending_subscription_split/);
});

test("verified activation and renewal events ensure one included-credit grant per paid period",()=>{
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

test("legacy Flutterwave manual renewal is normalized and receives its missing period allowance",()=>{
 assert.match(manualRenewal,/renewal_applied/);
 assert.doesNotMatch(manualRenewal,/subscription_applied/);
 assert.match(migration,/renewal_applied/);
 assert.match(migration,/jsonb_build_object\('subscription_applied',true\)/);
 assert.match(migration,/SUBSCRIPTION_PERIOD_NOT_APPLIED/);
});

test("existing provider finalizers remain the payment authority and are covered by the bridge",()=>{
 assert.match(providerBilling,/finalize_subscription_purchase_for_provider/);
 assert.match(providerBilling,/finalize_subscription_renewal_for_provider/);
 assert.match(providerBilling,/finalize_paddle_subscription_renewal/);
 assert.match(providerBilling,/subscription-purchase:/);
 assert.match(providerBilling,/subscription-renewal:/);
 assert.match(migration,/payment_row\.provider<>new\.source/);
});

test("bridge is forward-only: it adds no public pricing, historic balance backfill or live checkout activation",()=>{
 assert.doesNotMatch(migration,/insert into executive_visuals\.subscription_plans/i);
 assert.doesNotMatch(migration,/update executive_visuals\.subscription_plans/i);
 assert.doesNotMatch(migration,/update executive_visuals\.billing_credit_ledger/i);
 assert.doesNotMatch(migration,/delete from executive_visuals\.billing_credit_ledger/i);
 assert.match(pricing,/'draft'/);
 assert.match(pricing,/'false,1/);
 assert.match(migration,/revoke all on function executive_visuals\.bridge_subscription_credit_grant_to_generation_wallet\(\)/);
 assert.match(migration,/revoke all on function executive_visuals\.ensure_subscription_period_credit_grant\(\)/);
});
