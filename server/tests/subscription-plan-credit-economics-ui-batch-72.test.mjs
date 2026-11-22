import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync(new URL("../../src/platform/app.ts",import.meta.url),"utf8");

test("Financial Command Centre renders the read-only subscription plan credit simulator",()=>{
 assert.match(app,/Plan credit allowance simulator/);
 assert.match(app,/finance-plan-credit-share/);
 assert.match(app,/finance-plan-credit-scenarios/);
 assert.match(app,/data-finance-subscription-plan-economics/);
 assert.ok(app.includes("/api/admin/finance/subscription-plan-economics"));
});

test("plan simulator displays draft plan allowances, model coverage, provider costs and limitations",()=>{
 assert.match(app,/proposedMonthlyCreditAllowance/);
 assert.match(app,/maximumWholeGenerations/);
 assert.match(app,/customerCreditsPerGeneration/);
 assert.match(app,/pricingDate/);
 assert.match(app,/pricingSource/);
 assert.match(app,/prefilled 70% budget share is only an example scenario/);
 assert.match(app,/Custom quote/);
 assert.match(app,/financeState\.planCreditEconomics\.limitations/);
 assert.match(app,/pricingPolicy\?\.targetMarginBps/);
 assert.match(app,/pricingPolicy\?\.paymentFeeBps/);
 assert.match(app,/pricingPolicy\?\.supportReserveBps/);
});

test("mixed workload results render fee-aware contribution, margin target and credit-fit status",()=>{
 assert.match(app,/Mixed monthly workload margin checks/);
 assert.match(app,/estimatedProviderCostMinor/);
 assert.match(app,/estimatedPaymentFeeMinor/);
 assert.match(app,/estimatedSupportReserveMinor/);
 assert.match(app,/estimatedContributionAfterProviderPaymentAndSupportUsd/);
 assert.match(app,/estimatedContributionMarginBps/);
 assert.match(app,/marginAssessment/);
 assert.match(app,/credit shortfall/);
 assert.match(app,/not net profit/);
});

test("plan simulator is a scenario-only control and does not activate plans or grant credits",()=>{
 const start=app.indexOf("Plan credit allowance simulator");
 const end=app.indexOf("REVENUE ASSURANCE · ADMIN ONLY",start);
 assert.ok(start>=0&&end>start);
 const panel=app.slice(start,end);
 assert.match(panel,/never activates plans or grants credits/);
 assert.doesNotMatch(panel,/\/api\/billing\/subscription/);
 assert.doesNotMatch(panel,/grant_generation_credits|reserve_generation_credits|checkout/);
});
