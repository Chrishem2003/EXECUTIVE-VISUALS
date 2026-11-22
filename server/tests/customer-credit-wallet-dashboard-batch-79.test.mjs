import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync(new URL("../../src/platform/app.ts",import.meta.url),"utf8");
const api=readFileSync(new URL("../financial-intelligence-api.mjs",import.meta.url),"utf8");

test("customer billing wallet renders live available, reserved, consumed and expiry balances",()=>{
 for(const label of ["Available to use","Reserved for jobs","Consumed","Expiring in 7 days","Pending expiry","Posted ledger balance"])
  assert.ok(app.includes(label),`missing wallet metric: ${label}`);
 assert.match(app,/Your creator credits/);
 assert.match(app,/Ready for generation/);
});

test("wallet dashboard explains subscription allowance expiry and purchased credit pack treatment",()=>{
 assert.match(app,/Subscription allowances may expire at the verified billing-period end/);
 assert.match(app,/Purchased credit packs do not expire/);
 assert.match(app,/expiryDeferred/);
 assert.match(app,/new jobs cannot spend those credits/);
});

test("wallet dashboard displays source lots and recent customer transaction activity",()=>{
 assert.match(app,/CREDIT LOTS/);
 assert.match(app,/Where your balance comes from/);
 assert.match(app,/WALLET ACTIVITY/);
 assert.match(app,/Recent credit transactions/);
 assert.match(app,/creditsRemaining/);
 assert.match(app,/recentTransactions/);
});

test("wallet API uses the authenticated owner, validates database values and redacts internal evidence",()=>{
 assert.match(api,/get_customer_credit_wallet/);
 assert.match(api,/p_owner_id:ownerId/);
 assert.match(api,/CREDIT_WALLET_INVALID/);
 assert.match(api,/recentTransactions/);
 assert.doesNotMatch(api,/evidence:entry\.evidence/);
 assert.match(api,/get_generation_credit_balance/);
});

test("wallet UI does not introduce checkout, top-up or plan-activation actions",()=>{
 const start=app.indexOf("GENERATION WALLET · LIVE ACCOUNT BALANCE");
 const end=app.indexOf("CREATOR MOMENTUM",start);
 assert.ok(start>=0&&end>start);
 const panel=app.slice(start,end);
 assert.doesNotMatch(panel,/data-billing-purchase|data-credit-topup|checkout/);
});
