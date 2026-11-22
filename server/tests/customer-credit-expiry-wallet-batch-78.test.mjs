import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const root=new URL("../../",import.meta.url);
const [migration,walletFoundation,revenueAllocation,subscriptionBridge]=await Promise.all([
 readFile(new URL("supabase/migrations/20261122250000_customer_credit_expiry_wallet_batch_78.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261109230000_cloud_customer_credit_reservations.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261122230000_verified_credit_revenue_allocation_batch_71.sql",root),"utf8"),
 readFile(new URL("supabase/migrations/20261122240000_subscription_credit_wallet_bridge_batch_77.sql",root),"utf8")
]);

test("only subscription allowances inherit a verified billing-period expiry; top-ups remain non-expiring",()=>{
 assert.match(migration,/source_type<>'subscription_allowance'/);
 assert.match(migration,/legacyCreditLedgerId/);
 assert.match(migration,/metadata->>'period_end'/);
 assert.match(migration,/try_parse_credit_period_end\(metadata->>'period_end'\)/);
 assert.match(migration,/new\.expires_at:=period_end/);
 assert.match(migration,/Purchased packs and non-subscription grants do not expire/);
 assert.match(revenueAllocation,/paid_credit_pack/);
 assert.match(subscriptionBridge,/period_end/);
});

test("expiry is append-only, idempotent and limited to the unconsumed source remainder",()=>{
 assert.match(migration,/create table if not exists executive_visuals\.billing_credit_source_expirations/);
 assert.match(migration,/source_id uuid not null unique/);
 assert.match(migration,/credits_expired bigint not null check\(credits_expired>=0\)/);
 assert.match(migration,/source_row\.credits_granted-v_consumed/);
 assert.match(migration,/credit-expiry:/);
 assert.match(migration,/'expiry',source_row\.grant_ledger_id/);
 assert.match(migration,/not exists\(select 1 from executive_visuals\.billing_credit_source_expirations e where e\.source_id=s\.id\)/);
 assert.match(walletFoundation,/generation_settlement','expiry'/);
});

test("open generation reservations defer expiry instead of invalidating in-flight work",()=>{
 assert.match(migration,/r\.state='reserved'/);
 assert.match(migration,/accountsDeferredForOpenReservations/);
 assert.match(migration,/BILLING_CREDIT_EXPIRY_DEFERRED_OPEN_RESERVATION/);
 assert.match(migration,/defer all expiry for this owner/);
});

test("reservation RPC expires due allowances before checking spendable wallet balance",()=>{
 assert.match(migration,/reserve_generation_credits_pre_batch78/);
 assert.match(migration,/perform executive_visuals\.expire_due_subscription_credits\(p_owner_id,clock_timestamp\(\)\)/);
 assert.match(migration,/reserve_generation_credits_pre_batch78\(/);
 assert.match(migration,/grant execute on function executive_visuals\.reserve_generation_credits/);
});

test("wallet summary exposes available, reserved, consumed, expiring, lots and recent ledger history",()=>{
 for(const field of ["availableCredits","pendingExpiryCredits","expiryDeferred","reservedCredits","consumedCredits","expiringWithinSevenDays","creditLots","recentTransactions","expiresAt","creditsRemaining"])
   assert.ok(migration.includes(field),`missing wallet field ${field}`);
 assert.match(migration,/limit 100/);
 assert.match(migration,/get_customer_credit_wallet\(uuid\)/);
 assert.match(migration,/grant execute on function executive_visuals\.get_customer_credit_wallet\(uuid\) to service_role/);
});

test("expiry functions and tables remain service-role-only; no customer pricing or payment activation",()=>{
 assert.match(migration,/revoke all on function executive_visuals\.expire_due_subscription_credits\(uuid,timestamptz\)[\s\S]*grant execute[\s\S]*to service_role/);
 assert.match(migration,/revoke all on function executive_visuals\.get_customer_credit_wallet\(uuid\)[\s\S]*grant execute[\s\S]*to service_role/);
 assert.doesNotMatch(migration,/insert into executive_visuals\.subscription_plans/i);
 assert.doesNotMatch(migration,/update executive_visuals\.subscription_plans/i);
 assert.doesNotMatch(migration,/checkout/i);
});
