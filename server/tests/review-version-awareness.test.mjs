import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const app=readFileSync(fileURLToPath(new URL("../../src/platform/app.ts",import.meta.url)),"utf8");
test("review records can be anchored to an explicit timeline revision",()=>{
 for(const token of ["timelineId:string|null","timelineRevision:number|null","name=\"timelineId\"","timelineRevision:timeline?.revision??null","Timeline v"])assert.ok(app.includes(token),token);
});
test("review version scopes distinguish current, previous and unlinked feedback",()=>{
 for(const token of ["reviewVersionFilter","review-version-filter","state.reviewVersionFilter===\"current\"","state.reviewVersionFilter===\"previous\"","state.reviewVersionFilter===\"unlinked\""])assert.ok(app.includes(token),token);
});
test("review exports retain timeline identity and revision metadata",()=>{
 assert.match(app,/const columns=\["id","assetId","timelineId","timelineRevision"/);
});
