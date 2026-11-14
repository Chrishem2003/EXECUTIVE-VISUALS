import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const migration=await readFile(new URL("../../supabase/migrations/20261121120000_paddle_pesapal_provider_billing.sql",import.meta.url),"utf8");

test("provider migration extends existing ledger without removing Flutterwave compatibility",()=>{
  assert.match(migration,/provider in \('flutterwave','paddle','pesapal'\)/);
  assert.match(migration,/source in \('system','flutterwave','paddle','pesapal','admin'\)/);
  assert.match(migration,/reserve_subscription_purchase_for_provider/);
  assert.match(migration,/finalize_subscription_purchase_for_provider/);
});

test("provider pricing keeps Paddle supported currencies separate from Ugandan Pesapal pricing",()=>{
  assert.match(migration,/provider='paddle'.*provider_price_id is not null and provider_price_id ~ '\^pri_/s);
  assert.match(migration,/currency in \('USD','EUR','GBP'\)/);
  assert.match(migration,/provider='pesapal'.*provider_price_id is null and currency='UGX'/s);
  assert.match(migration,/unique\(plan_id,provider\)/);
});

test("checkout reservation is server-priced, owner-serialized and idempotent",()=>{
  assert.match(migration,/pg_advisory_xact_lock\(hashtextextended\(p_owner_id::text,0\)\)/);
  assert.match(migration,/metadata->>'idempotency_key'=p_idempotency_key/);
  assert.match(migration,/provider=lower\(p_provider\)/);
  assert.match(migration,/subscription_plan_provider_prices/);
  assert.match(migration,/for share/);
  assert.match(migration,/status,'pending'/);
});

test("provider finalization verifies reserved amount, currency, reference and owner before entitlement grant",()=>{
  assert.match(migration,/amount_minor<>payment_row\.amount_minor/);
  assert.match(migration,/currency_code<>payment_row\.currency/);
  assert.match(migration,/reference<>payment_row\.tx_ref/);
  assert.match(migration,/owner_id=payment_row\.owner_id/);
  assert.match(migration,/subscription_row\.provider<>provider_name/);
  assert.match(migration,/on conflict\(owner_id,idempotency_key\) do nothing/);
  assert.match(migration,/source,reason,event_data/);
});

test("provider price records are server-only and provider RPCs are service-role only",()=>{
  assert.match(migration,/enable row level security/);
  assert.match(migration,/revoke all on function executive_visuals\.reserve_subscription_purchase_for_provider/);
  assert.match(migration,/grant execute on function executive_visuals\.reserve_subscription_purchase_for_provider[\s\S]*?to service_role/);
  assert.match(migration,/grant execute on function executive_visuals\.finalize_subscription_purchase_for_provider[\s\S]*?to service_role/);
});

test("Paddle recurring renewals are separately reserved, idempotent and lifecycle-controlled",()=>{
  assert.match(migration,/reserve_paddle_subscription_renewal/);
  assert.match(migration,/finalize_paddle_subscription_renewal/);
  assert.match(migration,/apply_paddle_subscription_lifecycle/);
  assert.match(migration,/provider_subscription_id=p_provider_subscription_id/);
  assert.match(migration,/subscription-renewal:/);
  assert.match(migration,/subscription_row\.status='pending'.*next_status:='pending'/s);
});
