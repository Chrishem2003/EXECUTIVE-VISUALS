import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root=new URL("../../",import.meta.url);
const [index,api]=await Promise.all([
 readFile(new URL("server/index.mjs",root),"utf8"),
 readFile(new URL("server/financial-intelligence-api.mjs",root),"utf8")
]);

test("video preflight reads the active server-side margin policy and evaluates each priced shot",()=>{
 assert.match(index,/evaluatePlatformMarginPreflight/);
 assert.match(index,/financialApi\?\.getPlatformVideoMarginPolicy/);
 assert.match(index,/customerPriceEvidencePerShot:perShotCredits\.map/);
 assert.match(index,/platformMarginPolicyResult/);
});

test("policy read failure fails closed rather than bypassing the margin gate",()=>{
 assert.match(index,/PLATFORM_MARGIN_POLICY_READ_FAILED/);
 assert.match(index,/platformMarginPolicyResult\s*\}\)\)/);
});

test("margin policy reader is an internal server method backed by the private database client",()=>{
 assert.match(api,/async function getPlatformVideoMarginPolicy\(\)/);
 assert.match(api,/platform_financial_policies\?select=policy_key,enabled,minimum_gross_margin_bps/);
 assert.match(api,/getPlatformVideoMarginPolicy,/);
});
