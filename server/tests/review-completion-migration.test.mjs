import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationPath=fileURLToPath(new URL("../../supabase/migrations/20261106160000_review_completion_audit.sql",import.meta.url));
const migration=readFileSync(migrationPath,"utf8");

test("review completion audit records the actual last actor",()=>{
 assert.match(migration,/actor\s*:=\s*coalesce\(new\.last_actor_id,new\.reviewer_id,new\.owner_id\)/);
 assert.match(migration,/new\.last_actor_id/);
});

test("review completion audit distinguishes resolve, dismiss and reopen transitions",()=>{
 for(const event of ["review.resolved","review.dismissed","review.reopened"])assert.ok(migration.includes(event));
 assert.match(migration,/old\.status not in \('resolved','dismissed'\) and new\.status='resolved'/);
 assert.match(migration,/old\.status not in \('resolved','dismissed'\) and new\.status='dismissed'/);
 assert.match(migration,/old\.status in \('resolved','dismissed'\) and new\.status='open'/);
});

test("review event trigger ignores metadata-only writes",()=>{
 assert.match(migration,/row\(new\.body,new\.decision,new\.status,new\.visibility,new\.annotation,/);
 assert.match(migration,/is not distinct from/);
});
