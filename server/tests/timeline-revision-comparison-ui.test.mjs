import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const source=await readFile(fileURLToPath(new URL("../../src/platform/timeline-workspace.ts",import.meta.url)),"utf8");
const css=await readFile(fileURLToPath(new URL("../../src/platform/style.css",import.meta.url)),"utf8");
test("cloud timeline workspace exposes revision history and comparison controls",()=>{
 for(const token of ["cloudTimelineVersions","/versions","data-tl-load-revisions","tl-revision-base","data-tl-compare-revision","compareTimelineVariants"])assert.ok(source.includes(token),token);
});
test("revision comparison is read-only and does not replace the active timeline",()=>{
 assert.match(source,/compareTimelineVariants\(base\.timeline,state\.timeline\)/);
 assert.match(source,/state\.revisionComparison=compareTimelineVariants/);
 assert.doesNotMatch(source,/state\.timeline=base\.timeline/);
});
test("revision comparison panel has responsive styles",()=>{
 assert.match(css,/\.revision-comparison-panel/);
 assert.match(css,/@media\(max-width:680px\)/);
});
