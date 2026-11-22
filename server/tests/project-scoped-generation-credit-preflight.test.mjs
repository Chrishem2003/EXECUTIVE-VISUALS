import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const root=new URL("../../",import.meta.url);
const [migration,api]=await Promise.all([
 readFile(new URL("supabase/migrations/20261122140000_project_scoped_generation_credit_preflight.sql",root),"utf8"),
 readFile(new URL("server/cloud-timeline-api.mjs",root),"utf8")
]);

test("project-scoped credit preflight reads the same wallet selected by atomic generation reservation",()=>{
 assert.match(migration,/get_generation_credit_balance_for_project\(\s*p_owner_id uuid,p_project_id uuid\s*\)/i);
 assert.match(migration,/from project_credit_pools where project_id=p_project_id/i);
 assert.match(migration,/from project_credit_pool_ledger where project_id=p_project_id/i);
 assert.match(migration,/from project_credit_pool_reservations[\s\S]*state='reserved'/i);
 assert.match(migration,/from billing_credit_ledger where owner_id=p_owner_id/i);
 assert.match(migration,/from billing_credit_reservations[\s\S]*state='reserved'/i);
 assert.match(migration,/PROJECT_CREDIT_POOL_OWNER_MISMATCH/);
 assert.match(migration,/BILLING_CREDIT_BALANCE_PROJECT_FORBIDDEN/);
 assert.match(migration,/revoke all on function executive_visuals\.get_generation_credit_balance_for_project[\s\S]*from public,anon,authenticated/i);
 assert.match(migration,/grant execute on function executive_visuals\.get_generation_credit_balance_for_project[\s\S]*to service_role/i);
});

test("generation quotes show advisory wallet affordability but keep atomic approval as the authoritative gate",()=>{
 assert.match(api,/rpc\/get_generation_credit_balance_for_project/);
 assert.match(api,/creditAvailability/);
 assert.match(api,/canCoverQuote:status==="sufficient"/);
 assert.match(api,/approval RPC remains the authoritative balance and reservation gate/);
 assert.match(api,/rpc\/record_video_workflow_quote_with_customer_credits/);
});
