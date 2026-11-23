import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const migration=await readFile(new URL("../../supabase/migrations/20261123110000_verified_credit_pack_generation_wallet_settlement_batch_104.sql",import.meta.url),"utf8");
const integration=await readFile(new URL("../../scripts/verified-credit-pack-generation-wallet-postgres-integration-batch-104.sql",import.meta.url),"utf8");
const api=await readFile(new URL("../financial-intelligence-api.mjs",import.meta.url),"utf8");

test("credit-pack products are inactive by default and server-only",()=>{
 assert.match(migration,/active boolean not null default false/i);
 assert.match(migration,/alter table executive_visuals\.billing_products enable row level security/i);
 assert.match(migration,/revoke all on executive_visuals\.billing_products from public,anon,authenticated/i);
 assert.match(migration,/grant select on executive_visuals\.billing_products to service_role/i);
 assert.match(migration,/grant usage on schema executive_visuals to service_role/i);
});

test("credit-pack settlement verifies the exact Flutterwave payment and server snapshot",()=>{
 assert.match(migration,/payment_row\.provider is distinct from 'flutterwave'/);
 assert.match(migration,/p_provider_payload->>'id'/);
 assert.match(migration,/p_provider_payload->>'reference'/);
 assert.match(migration,/p_provider_payload->>'amount'/);
 assert.match(migration,/payment_row\.metadata->>'product_type'<>'credit_pack'/);
 assert.match(migration,/CREDIT_PACK_PAYMENT_NOT_PENDING/);
});

test("verified payment grants customer generation credits atomically and idempotently",()=>{
 assert.match(migration,/grant_generation_credits\(/);
 assert.match(migration,/grant_key:='credit-pack:'/);
 assert.match(migration,/credit_pack_applied/);
 assert.match(migration,/credit_pack_grant_ledger_id/);
 assert.match(migration,/CREDIT_PACK_GRANT_FAILED/);
 assert.match(integration,/Credit-pack replay duplicated wallet credits/);
 assert.match(integration,/Mismatched provider amount was incorrectly accepted/);
 assert.match(integration,/Failed payment was incorrectly eligible/);
});

test("verified credit pack settlement creates an invoice and deduplicated notification",()=>{
 assert.match(migration,/insert into executive_visuals\.billing_invoices/);
 assert.match(migration,/credit_pack_purchase/);
 assert.match(migration,/insert into executive_visuals\.billing_notification_outbox/);
 assert.match(migration,/credit-pack-purchase:/);
 assert.match(integration,/Verified credit-pack purchase invoice was not created/);
 assert.match(integration,/Credit-pack purchase notification was not queued/);
 assert.match(integration,/Credit-pack replay duplicated invoice/);
 assert.match(integration,/Credit-pack replay duplicated notification/);
});

test("checkout routes only verified credit pack products to the generation-wallet finalizer",()=>{
 assert.match(api,/product\.product_type!==\"credit_pack\"/);
 assert.match(api,/product_version:Number\(product\.version\)/);
 assert.match(api,/product_amount_minor:Number\(product\.amount_minor\)/);
 assert.match(api,/payment\.metadata\?\.product_type===\"credit_pack\"/);
 assert.match(api,/finalize_credit_pack_purchase/);
 assert.match(api,/CREDIT_PACK_PAYMENT_PENDING/);
});
