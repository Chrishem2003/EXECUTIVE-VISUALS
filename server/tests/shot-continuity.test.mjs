import test from "node:test";
import assert from "node:assert/strict";
import { buildShotContinuityPrompt, getShotContinuityReferenceIds, buildShotContinuityReport } from "../shot-continuity.mjs";
const document={
 shots:[{id:"shot-1",scene:"Arrival",action:"Walks into frame",characterIds:["char-1","char-1"],location:"Kampala studio",timeOfDay:"Golden hour",visualPrompt:"Warm cinematic close-up",continuityIn:"Jacket buttoned",continuityOut:"Turns left",camera:"Medium close-up",lens:"50mm",movement:"Slow dolly",lighting:"Soft key",aspectRatio:"16:9"}],
 characters:[{id:"char-1",name:"Amina",description:"Presenter",appearance:"Short natural hair",wardrobe:"Blue jacket",voiceProfile:"Warm and measured",continuityNotes:"Keep jacket buttoned"}]
};
test("builds deterministic shot and selected-character context without exposing asset IDs",()=>{
 const result=buildShotContinuityPrompt({document,shotId:"shot-1",prompt:"Create the opening frame."});
 for(const value of ["Create the opening frame.","SHOT CONTINUITY","Kampala studio","Golden hour","CHARACTER 1","Amina","Short natural hair","Blue jacket","Warm and measured","Keep jacket buttoned","Slow dolly"])assert.ok(result.includes(value),value);
 assert.equal((result.match(/CHARACTER 1/g)||[]).length,1);
});
test("fails closed when a shot or linked character is missing or ambiguous",()=>{
 assert.throws(()=>buildShotContinuityPrompt({document,shotId:"missing",prompt:"Make a frame"}),error=>error.code==="SHOT_CONTEXT_NOT_FOUND");
 assert.throws(()=>buildShotContinuityPrompt({document:{...document,characters:[]},shotId:"shot-1",prompt:"Make a frame"}),error=>error.code==="SHOT_CHARACTER_NOT_FOUND");
 assert.throws(()=>buildShotContinuityPrompt({document:{...document,shots:[...document.shots,document.shots[0]]},shotId:"shot-1",prompt:"Make a frame"}),error=>error.code==="SHOT_CONTEXT_NOT_FOUND");
});
test("requires a non-empty user prompt",()=>{
 assert.throws(()=>buildShotContinuityPrompt({document,shotId:"shot-1",prompt:"  "}),error=>error.code==="PROMPT_REQUIRED");
});

test("authorizes every linked character before exposing continuity details",()=>{
 const authorized=[];
 const result=buildShotContinuityPrompt({document,shotId:"shot-1",prompt:"Create a frame",authorizeCharacter:profile=>authorized.push(profile.id)});
 assert.deepEqual(authorized,["char-1"]);
 assert.ok(result.includes("Amina"));
 assert.throws(()=>buildShotContinuityPrompt({document,shotId:"shot-1",prompt:"Create a frame",authorizeCharacter:()=>{throw Object.assign(new Error("No consent"),{code:"IDENTITY_PERMISSION_REQUIRED"});}}),error=>error.code==="IDENTITY_PERMISSION_REQUIRED");
});

test("collects only references attached to the selected shot and its linked characters",()=>{
 const referenced={...document,shots:[{...document.shots[0],referenceAssetIds:["shot-ref","shared-ref"]}],characters:[{...document.characters[0],referenceAssetIds:["character-ref","shared-ref"]},{id:"char-2",name:"Other",referenceAssetIds:["unlinked-ref"]}]};
 assert.deepEqual(getShotContinuityReferenceIds({document:referenced,shotId:"shot-1"}),["shot-ref","shared-ref","character-ref"]);
});
test("rejects missing or ambiguous shots while resolving references",()=>{
 assert.throws(()=>getShotContinuityReferenceIds({document,shotId:"missing"}),error=>error.code==="SHOT_CONTEXT_NOT_FOUND");
 assert.throws(()=>getShotContinuityReferenceIds({document:{...document,shots:[...document.shots,document.shots[0]]},shotId:"shot-1"}),error=>error.code==="SHOT_CONTEXT_NOT_FOUND");
});

test("compares declared continuity metadata across shots without constraining camera variation",()=>{
 const report=buildShotContinuityReport([
  {id:"a",continuityGroup:"scene-1",continuity:{identity:"Host A",wardrobe:"Blue jacket",location:"Studio",props:"Tablet",lighting:"Soft key",colorGrade:"Warm"}},
  {id:"b",continuityGroup:"scene-1",continuity:{identity:"Host A",wardrobe:"Red jacket",location:"Studio",props:"Tablet",lighting:"Soft key",colorGrade:"Warm"},camera:"Wide"},
  {id:"c",continuityGroup:"scene-2",continuity:{identity:"Host B",wardrobe:"Green shirt"}}
 ]);
 assert.equal(report.status,"review");assert.equal(report.shotCount,3);assert.equal(report.groupCount,2);
 assert.deepEqual(report.findings.filter(item=>item.code==="CONTINUITY_VARIATION").map(item=>({shotId:item.shotId,field:item.field})),[{shotId:"b",field:"wardrobe"}]);
 assert.ok(report.limitations.some(item=>item.includes("Camera framing")));
});
test("bounds and validates continuity report inputs",()=>{
 assert.throws(()=>buildShotContinuityReport({}),TypeError);assert.throws(()=>buildShotContinuityReport([null]),TypeError);
 assert.throws(()=>buildShotContinuityReport(Array(501).fill({id:"x"})),RangeError);
});
