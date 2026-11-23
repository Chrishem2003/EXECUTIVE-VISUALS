import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const root=join(dirname(fileURLToPath(import.meta.url)),"../../supabase/migrations");
const sql=readFileSync(join(root,"20261123180000_financial_fx_rate_evidence_batch_96.sql"),"utf8");
test("FX evidence is append-only, scoped, audited and maker-checker controlled",()=>{
 assert.match(sql,/create table if not exists executive_visuals\.financial_fx_rate_evidence/);
 assert.match(sql,/create table if not exists executive_visuals\.financial_fx_rate_decisions/);
 assert.match(sql,/before update or delete on executive_visuals\.financial_fx_rate_evidence/);
 assert.match(sql,/before update or delete on executive_visuals\.financial_fx_rate_decisions/);
 assert.match(sql,/Settlement-cost conversion requires processor settlement or bank statement evidence/);
 assert.match(sql,/FX evidence maker cannot approve their own evidence/);
 assert.match(sql,/write_financial_admin_audit/);
 assert.match(sql,/financial_fx_rate_evidence_current/);
 assert.match(sql,/grant select on executive_visuals\.financial_fx_rate_evidence_current to service_role/);
});
test("FX evidence and decision tables are not directly accessible to browser roles",()=>{
 assert.match(sql,/revoke all on executive_visuals\.financial_fx_rate_evidence,executive_visuals\.financial_fx_rate_decisions from public,anon,authenticated/);
 assert.match(sql,/grant execute on function executive_visuals\.record_financial_fx_rate_evidence/);
 assert.match(sql,/grant execute on function executive_visuals\.decide_financial_fx_rate_evidence/);
});
