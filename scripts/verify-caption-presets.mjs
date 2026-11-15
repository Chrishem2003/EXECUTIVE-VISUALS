import assert from "node:assert/strict";
import { applyCaptionPreset, CAPTION_PRESETS, getCaptionPreset } from "../src/core/caption-presets.ts";
import { captionStyle } from "../server/media.mjs";
assert.equal(CAPTION_PRESETS.length,5);
assert.equal(new Set(CAPTION_PRESETS.map(item=>item.id)).size,CAPTION_PRESETS.length);
for(const preset of CAPTION_PRESETS){
 assert.ok(preset.fontSize>=12&&preset.fontSize<=96);
 assert.ok(preset.alignment>=1&&preset.alignment<=9);
 assert.ok(preset.backgroundOpacity>=0&&preset.backgroundOpacity<=1);
 assert.ok(preset.outline>=0&&preset.outline<=8);
 assert.ok(preset.shadow>=0&&preset.shadow<=8);
 assert.ok(preset.marginV>=0&&preset.marginV<=240);
 assert.match(preset.primaryColor,/^#[0-9a-f]{6}$/i);
 const rendered=captionStyle(applyCaptionPreset(preset.id));
 assert.ok(rendered.includes("FontName="+preset.fontName));
 assert.ok(rendered.includes("FontSize="+preset.fontSize));
 assert.ok(rendered.includes("Alignment="+preset.alignment));
 assert.ok(rendered.includes("Outline="+preset.outline));
 assert.ok(rendered.includes("Shadow="+preset.shadow));
 assert.ok(rendered.includes("MarginV="+preset.marginV));
 assert.ok(rendered.includes("BorderStyle="+(preset.backgroundMode==="box"?3:1)));
}
const previous={customTag:"keep-me",fontSize:18};
const applied=applyCaptionPreset("social-bold",previous);
assert.equal(applied.fontSize,46);
assert.equal(applied.presetId,"social-bold");
assert.equal(applied.customTag,"keep-me");
assert.equal(previous.fontSize,18,"preset application must not mutate the input object");
assert.equal(getCaptionPreset("unknown"),undefined);
assert.throws(()=>applyCaptionPreset("unknown"),/unknown caption preset/i);
console.log("Caption preset checks passed: unique presets, renderer output mapping, supported ranges, immutable application and unknown-preset rejection.");

const trackClips=[
 {id:"caption-1",timelineStart:0,duration:48,metadata:{custom:"preserve",fontSize:20}},
 {id:"caption-2",timelineStart:48,duration:72,metadata:{speaker:"narrator",fontSize:24}},
 {id:"caption-3",timelineStart:120,duration:36,metadata:{creativeTrace:{storyBeat:"payoff"}}}
];
const trackResult=applyCaptionPresetToClips(trackClips,"cinematic");
assert.equal(trackResult.length,3);
assert.deepEqual(trackResult.map(item=>item.metadata?.presetId),["cinematic","cinematic","cinematic"]);
assert.deepEqual(trackResult.map(item=>item.metadata?.fontSize),[34,34,34]);
assert.equal(trackResult[0].metadata?.custom,"preserve");
assert.equal(trackResult[1].metadata?.speaker,"narrator");
assert.deepEqual(trackResult[2].metadata?.creativeTrace,{storyBeat:"payoff"});
assert.equal(trackClips[0].metadata?.fontSize,20,"track application must not mutate the original clips");
assert.equal(trackResult[0].id,"caption-1");
assert.equal(trackResult[1].timelineStart,48);
console.log("Caption track preset checks passed: every clip styled, clip timing/identity preserved, unrelated metadata retained and source clips unchanged.");
