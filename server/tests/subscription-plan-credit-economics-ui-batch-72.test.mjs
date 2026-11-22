import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const app=readFileSync(new URL("../../src/platform/app.ts",import.meta.url),"utf8");

test("Financial Command Centre renders the read-only subscription plan credit simulator",()=>{
 assert.match(app,/Plan credit allowance simulator/);
 assert.match(app,/finance-plan-credit-share/);
 assert.match(app,/finance-plan-credit-scenarios/);
 assert.match(app,/data-finance-subscription-plan-economics/);
 assert.match(app,/\\/api\\/admin\\/finance\\/subscription-plan-economics/);
});

test("plan simulator displays draft plan allowances, model coverage, provider costs and limitations",()=>{
 assert.match(app,/proposedMonthlyCreditAllowance/);
 assert.match(app,/maximumWholeGenerations/);
 assert.match(app,/customerCreditsPerGeneration/);
 assert.match(app,/pricingDate/);
 assert.match(app,/financeState\.planCreditEconomics\.limitations/);
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
