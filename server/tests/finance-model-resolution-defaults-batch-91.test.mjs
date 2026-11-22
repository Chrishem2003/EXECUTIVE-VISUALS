import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("finance command-centre default benchmark uses supported provider model resolutions",async()=>{
 const app=await readFile(new URL("../../src/platform/app.ts",import.meta.url),"utf8");
 const match=app.match(/planEconomicsScenarioJson:"((?:\\\\.|[^"])*)"/);
 assert.ok(match,"default subscription economics scenarios must be present");
 const scenarios=JSON.parse(match[1].replaceAll("\\\"","\""));
 assert.deepEqual(scenarios.map(({model,resolution})=>({model,resolution})),[
  {model:"gen4.5",resolution:"720p"},
  {model:"seedance2_5",resolution:"1080p"},
  {model:"kling_4",resolution:"1080p"}
 ]);
});
