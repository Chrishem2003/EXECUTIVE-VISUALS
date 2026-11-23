import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const app=await readFile(new URL("../../src/platform/app.ts",import.meta.url),"utf8");

test("Billing loads active server-priced credit pack catalogue records",()=>{
 assert.match(app,/apiRequest<\{products:BillingProduct\[\]\}>\("\/api\/billing\/products"\)/);
 assert.match(app,/product\.product_type===\"credit_pack\"/);
 assert.match(app,/billingState\.products=products\.products\|\|\[\]/);
});

test("customer can start a one-time mobile money credit-pack checkout",()=>{
 assert.match(app,/id=\"billing-credit-pack-form\"/);
 assert.match(app,/name=\"productCode\"/);
 assert.match(app,/name=\"network\"/);
 assert.match(app,/\/api\/billing\/checkout/);
 assert.match(app,/idempotency-key/);
 assert.match(app,/f\.dataset\.idempotencyKey\|\|crypto\.randomUUID\(\)/);
 assert.match(app,/Credits are added only after verified payment/);
});

test("credit pack panel stays unavailable until an active pack is published",()=>{
 assert.match(app,/No credit packs are currently published/);
 assert.match(app,/Additional-credit pricing remains subject to provider-cost and margin approval/);
});
