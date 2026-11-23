import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const migration=await readFile(new URL("../../supabase/migrations/20261123100000_subscription_generation_credit_allowances_batch_103.sql",import.meta.url),"utf8");
const integration=await readFile(new URL("../../scripts/subscription-generation-credit-allowances-postgres-integration-batch-103.sql",import.meta.url),"utf8");
const workflow=await readFile(new URL("../../.github/workflows/billing-self-service.yml",import.meta.url),"utf8");
const catalogue=await readFile(new URL("../subscription-plan-catalogue.mjs",import.meta.url),"utf8");
const api=await readFile(new URL("../financial-intelligence-api.mjs",import.meta.url),"utf8");

test("generation allowances are separate, unpublished by default and bounded",()=>{
 assert.match(migration,/add column if not exists included_generation_credits bigint not null default 0/i);
 assert.match(migration,/generation_credit_allowance_published boolean not null default false/i);
 assert.match(migration,/included_generation_credits between 0 and 1000000000/i);
 assert.match(migration,/legacy included_credits remains unchanged/i);
});

test("purchase and renewal snapshot only published allowances and grant through the immutable generation wallet",()=>{
 assert.match(migration,/sync_subscription_generation_credit_snapshot/);
 assert.match(migration,/sync_scheduled_subscription_generation_credit_snapshot/);
 assert.match(migration,/grant_generation_credits\(/);
 assert.match(migration,/verified_subscription_payment/);
 assert.match(migration,/admin_granted_subscription/);
 assert.match(migration,/subscription-generation:/);
 assert.match(migration,/SUBSCRIPTION_GENERATION_CREDIT_PAYMENT_EVIDENCE_MISSING/);
 assert.match(migration,/AFTER INSERT OR UPDATE OF status, current_period_start, current_period_end/i);
});

test("grant trigger is idempotent per subscription period and remains inside activation transaction",()=>{
 assert.match(migration,/to_char\(new\.current_period_start at time zone 'UTC','YYYYMMDDHH24MISSUS'\)/);
 assert.match(migration,/grant_generation_credits\([\s\S]*?new\.included_generation_credits/);
 assert.match(migration,/from public, anon, authenticated/);
 assert.match(integration,/Initial generation grant evidence was not recorded exactly once/);
 assert.match(integration,/Purchase replay duplicated generation credits/);
 assert.match(integration,/Renewal replay duplicated generation credits/);
 assert.match(integration,/Failed payment unexpectedly granted generation credits/);
});

test("published plan catalogue exposes generation credits separately and hides unapproved allowances",()=>{
 assert.match(catalogue,/generationCreditAllowancePublished/);
 assert.match(catalogue,/includedGenerationCredits/);
 assert.match(api,/included_generation_credits,generation_credit_allowance_published/);
 assert.match(api,/scheduled_included_generation_credits/);
});

test("billing PostgreSQL workflow applies and verifies Batch 103 in order",()=>{
 assert.match(workflow,/20261123100000_subscription_generation_credit_allowances_batch_103\.sql/);
 assert.match(workflow,/subscription-generation-credit-allowances-postgres-integration-batch-103\.sql/);
});
