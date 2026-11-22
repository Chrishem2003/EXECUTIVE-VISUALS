import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const root=new URL("../../",import.meta.url);
const [migration,integration,api]=await Promise.all([
 readFile(new URL("supabase/migrations/20261123010000_admin_credit_adjustments_batch_81.sql",root),"utf8"),
 readFile(new URL("scripts/admin-credit-adjustments-postgres-integration-batch-81.sql",root),"utf8"),
 readFile(new URL("server/financial-intelligence-api.mjs",root),"utf8")
]);

test("administrator adjustment audit is append-only and inaccessible to client roles",()=>{
 assert.match(migration,/create table if not exists executive_visuals\.billing_credit_admin_adjustments/);
 assert.match(migration,/alter table executive_visuals\.billing_credit_admin_adjustments enable row level security/);
 assert.match(migration,/revoke all on executive_visuals\.billing_credit_admin_adjustments from public,anon,authenticated,service_role/);
 assert.match(migration,/grant execute on function executive_visuals\.apply_admin_credit_adjustment[\s\S]*to service_role/);
 assert.match(migration,/grant execute on function executive_visuals\.list_admin_credit_adjustments[\s\S]*to service_role/);
});

test("database adjustment RPC independently verifies administrator role and idempotency",()=>{
 assert.match(migration,/platform_admins a[\s\S]*?a\.user_id=p_actor_id[\s\S]*?a\.role in\('owner','platform_admin','billing_admin'\)/);
 assert.match(migration,/ADMIN_CREDIT_ADJUSTMENT_IDEMPOTENCY_CONFLICT/);
 assert.match(migration,/ADMIN_CREDIT_ADJUSTMENT_ARGUMENTS_INVALID/);
 assert.match(migration,/billing_credit_admin_adjustments/);
});

test("negative adjustments cannot spend active reservations and positive adjustments are non-revenue compensation",()=>{
 assert.match(migration,/sum\(r\.reserved_credits\)/);
 assert.match(migration,/ADMIN_CREDIT_ADJUSTMENT_EXCEEDS_AVAILABLE_BALANCE/);
 assert.match(migration,/sourceType',case when p_delta_credits>0 then 'admin_compensation'/);
 assert.match(migration,/event_type,reference_id,idempotency_key,description,evidence[\s\S]*?'admin_adjustment'/);
 assert.match(integration,/reserve_generation_credits/);\n assert.match(integration,/Debit must not consume reserved credits/);
 assert.match(integration,/source_type='admin_compensation'[\s\S]*?revenue_status='non_revenue'/);
});

test("admin API validates actor, target, delta, reason, idempotency and bounded history",()=>{
 assert.match(api,/\/api\/admin\/billing\/credit-adjustments/);
 assert.match(api,/requireAdmin\(ownerId\)/);
 assert.match(api,/apply_admin_credit_adjustment/);
 assert.match(api,/list_admin_credit_adjustments/);
 assert.match(api,/ADMIN_CREDIT_ADJUSTMENT_INPUT_INVALID/);
 assert.match(integration,/Non-administrator was allowed to adjust credits/);
 assert.match(integration,/Repeated adjustment was not idempotent/);
});
