import test from "node:test";
import assert from "node:assert/strict";
import {priceWorkloadCostUnits} from "../ai-workload-economics.mjs";
import {createCustomerCreditQuotePolicy} from "../customer-credit-quote-policy.mjs";

const assumptions={targetMarginBps:6000,paymentFeeBps:300,supportReserveBps:500,fixedPaymentFeeMinor:0};
const ceilCents=micros=>Math.ceil(micros/10000);

test("10-second Seedance 2.5 1080p price floor covers provider cost, support reserve, fee and target margin",()=>{
 const result=priceWorkloadCostUnits(6_800_000,assumptions);
 assert.equal(result.reservedCostUnits,7_140_000);
 assert.equal(result.minimumPriceUnits,19_297_298);
 assert.equal(ceilCents(result.minimumPriceUnits),1930);
});

test("10-second Kling 4.0 1080p price floor is rounded upward in customer currency",()=>{
 const result=priceWorkloadCostUnits(2_350_000,assumptions);
 assert.equal(result.reservedCostUnits,2_467_500);
 assert.equal(result.minimumPriceUnits,6_668_919);
 assert.equal(ceilCents(result.minimumPriceUnits),667);
});

test("4.8 percent card-fee scenario is more conservative than Uganda mobile-money fee scenario",()=>{
 const card={...assumptions,paymentFeeBps:480};
 const seedanceMobile=priceWorkloadCostUnits(6_800_000,assumptions);
 const seedanceCard=priceWorkloadCostUnits(6_800_000,card);
 const klingMobile=priceWorkloadCostUnits(2_350_000,assumptions);
 const klingCard=priceWorkloadCostUnits(2_350_000,card);
 assert.equal(ceilCents(seedanceCard.minimumPriceUnits),2029);
 assert.equal(ceilCents(klingCard.minimumPriceUnits),701);
 assert.ok(seedanceCard.minimumPriceUnits>seedanceMobile.minimumPriceUnits);
 assert.ok(klingCard.minimumPriceUnits>klingMobile.minimumPriceUnits);
});

test("a five-second premium Seedance generation already exceeds the nine-dollar Starter hypothesis",()=>{
 const result=priceWorkloadCostUnits(3_400_000,assumptions);
 assert.equal(ceilCents(result.minimumPriceUnits),965);
 assert.ok(ceilCents(result.minimumPriceUnits)>900);
});

test("credit conversion is configurable and never silently fixes the commercial credit rate",()=>{
 const makePolicy=fee=>createCustomerCreditQuotePolicy({env:{
  NEON_CUSTOMER_CREDITS_PER_USD:"100",
  NEON_CUSTOMER_TARGET_MARGIN_BPS:"6000",
  NEON_CUSTOMER_PAYMENT_FEE_BPS:String(fee),
  NEON_CUSTOMER_SUPPORT_RESERVE_BPS:"500"
 }});
 assert.equal(makePolicy(300)({currency:"USD",amountMicros:6_800_000}),1930);
 assert.equal(makePolicy(480)({currency:"USD",amountMicros:6_800_000}),2029);
 assert.throws(()=>createCustomerCreditQuotePolicy({env:{
  NEON_CUSTOMER_CREDITS_PER_USD:"",
  NEON_CUSTOMER_TARGET_MARGIN_BPS:"6000"
 }}));
});
