import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const app=readFileSync(fileURLToPath(new URL("../../src/platform/app.ts",import.meta.url)),"utf8");
const css=readFileSync(fileURLToPath(new URL("../../src/platform/style.css",import.meta.url)),"utf8");
test("review workspace exposes search, status filters and deterministic sorting",()=>{
 for(const token of ["review-search","review-status-filter","review-sort","getVisibleCloudReviews","timecode","newest","oldest","completed"])assert.ok(app.includes(token),token);
});
test("review export supports scoped CSV and JSON downloads",()=>{
 assert.match(app,/exportCloudReviews\(format:"csv"\|"json"\)/);
 assert.match(app,/data-review-export="csv"/);
 assert.match(app,/data-review-export="json"/);
 assert.match(app,/filters:\{search:state\.reviewSearch,status:state\.reviewStatusFilter,sort:state\.reviewSort\}/);
 assert.match(app,/replace\(\/"\/g,'""'\)/);
});
test("review intelligence controls have responsive layout styles",()=>{
 assert.match(css,/\.review-intelligence-toolbar/);
 assert.match(css,/@media\(max-width:760px\)/);
});
