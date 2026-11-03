import test from "node:test";
import assert from "node:assert/strict";
import {getCaptionStylePreset,listCaptionStylePresets} from "../../src/core/caption-style-presets.ts";

test("provides reusable caption presets with independent returned values",()=>{
 const presets=listCaptionStylePresets();
 assert.ok(presets.length>=4);
 assert.equal(getCaptionStylePreset("social-bold").fontSize,48);
 const changed=getCaptionStylePreset("standard");changed.fontSize=1;
 assert.equal(getCaptionStylePreset("standard").fontSize,32);
});
test("rejects unknown caption preset IDs",()=>{
 assert.throws(()=>getCaptionStylePreset("unknown"),/Unknown caption style preset/);
});
