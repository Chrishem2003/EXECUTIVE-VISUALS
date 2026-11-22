import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const root=new URL("../../",import.meta.url);
const [migration,integration,api]=await Promise.all([
 readFile(new URL("supabase/migrations/20261122260000_verified_credit_pack_topups_batch_80.sql",root),"utf8"),
 readFile(new URL("scripts/credit-pack-verified-topup-postgres-integration-batch-80.sql",root),"utf8"),
 readFile(new URL("server/financial-intelligence-api.mjs",root),"utf8")
]);

test("credit-pack checkout stores an immutable server-owned purchase snapshot",()=>{
 assert.match(api,/product_type=eq\.credit_pack|product_type/);
 assert.match(api,/payment_purpose:"credit_pack_purchase"/);
 assert.match(api,/credit_pack_applied:false/);
 assert.match(api,/credit_pack_snapshot/);
 assert.match(api,/amountMinor:Number\(product\.amount_minor\)/);
 assert.match(api,/creditUnits:Number\(product\.credit_units\)/);
});

test("verified top-up finalizer validates snapshot and payment amount before grant triggers",()=>{
 assert.match(migration,/finalize_payment_purchase_pre_batch80/);
 assert.match(migration,/CREDIT_PACK_SNAPSHOT_INVALID/);
 assert.match(migration,/CREDIT_PACK_SNAPSHOT_PAYMENT_MISMATCH/);
 assert.match(migration,/payment_row\.amount_minor/);
 assert.match(migration,/credit_pack_applied/);
 assert.ok(migration.indexOf("credit_pack_applied',true")<migration.indexOf("finalize_payment_purchase_pre_batch80("));
});

test("only the service role can invoke the verified top-up finalizer",()=>{
 assert.match(migration,/revoke all on function executive_visuals\.finalize_payment_purchase\(uuid,text,jsonb,timestamptz\)[\s\S]*from public,anon,authenticated/);
 assert.match(migration,/grant execute on function executive_visuals\.finalize_payment_purchase\(uuid,text,jsonb,timestamptz\)[\s\S]*to service_role/);
 assert.match(migration,/revoke all on function executive_visuals\.finalize_payment_purchase_pre_batch80\(uuid,text,jsonb,timestamptz\)[\s\S]*from public,anon,authenticated,service_role/);
});

test("PostgreSQL integration proves one paid wallet grant, one verified revenue source and safe replay",()=>{
 assert.match(integration,/credit_pack_applied/);
 assert.match(integration,/billing_credit_revenue_sources/);
 assert.match(integration,/CREDIT_PACK_SNAPSHOT_PAYMENT_MISMATCH/);
 assert.match(integration,/Webhook replay duplicated a credit-pack grant/);
 assert.match(integration,/Mismatched checkout unexpectedly granted credits/);
});
