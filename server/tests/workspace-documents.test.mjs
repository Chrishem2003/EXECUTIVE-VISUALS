import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCreativeWorkspaceDocument } from "../workspace-documents.mjs";

test("workspace sanitizer persists bounded brand-kit identity, colors, typography and guardrails",()=>{
 const document=sanitizeCreativeWorkspaceDocument({
  brandKit:{name:"Northstar",tagline:"Make progress visible",voice:"Clear, practical and optimistic",visualStyle:"Natural light, confident framing",colors:{primary:"#112233",secondary:"#445566",accent:"#AABBCC",background:"#FFFFFF",text:"#101010"},typography:{heading:"Inter Display",body:"Inter"},prohibitedTerms:["guaranteed results","cure"],legalFooter:"Terms apply."},
  campaignTemplates:[{id:"vertical",name:"Vertical short",channel:"Reels",aspectRatio:"9:16",width:1080,height:1920,maxDurationSeconds:45,safeArea:{top:12,right:8,bottom:18,left:8},subtitleSafeArea:true}]
 });
 assert.equal(document.brandKit.name,"Northstar");
 assert.equal(document.brandKit.colors.primary,"#112233");
 assert.equal(document.brandKit.colors.accent,"#AABBCC");
 assert.equal(document.brandKit.typography.heading,"Inter Display");
 assert.deepEqual(document.brandKit.prohibitedTerms,["guaranteed results","cure"]);
 assert.equal(document.campaignTemplates[0].aspectRatio,"9:16");
 assert.equal(document.campaignTemplates[0].safeArea.bottom,18);
 assert.equal(document.campaignTemplates[0].subtitleSafeArea,true);
});

test("workspace sanitizer defaults brand kits for existing documents without breaking schema version 1",()=>{
 const document=sanitizeCreativeWorkspaceDocument({creativeProjects:[],variants:["old draft"]});
 assert.equal(document.schemaVersion,1);
 assert.equal(document.brandKit.colors.primary,"#202124");
 assert.deepEqual(document.campaignTemplates,[]);
 assert.deepEqual(document.variants,["old draft"]);
});

test("workspace sanitizer rejects invalid or overlong brand colors",()=>{
 for(const color of ["red","#123","#12345678","#123456<script>"]) {
  assert.throws(()=>sanitizeCreativeWorkspaceDocument({brandKit:{colors:{primary:color}}}),error=>error.code==="INVALID_BRAND_COLOR");
 }
});

test("workspace sanitizer rejects malformed campaign ratios and bounds template lists",()=>{
 assert.throws(()=>sanitizeCreativeWorkspaceDocument({campaignTemplates:[{id:"bad",aspectRatio:"portrait"}]}),error=>error.code==="INVALID_CAMPAIGN_TEMPLATE");
 const many=Array.from({length:45},(_,i)=>({id:String(i),name:"T"+i,channel:"Social",aspectRatio:"9:16"}));
 const document=sanitizeCreativeWorkspaceDocument({campaignTemplates:many});
 assert.equal(document.campaignTemplates.length,40);
 assert.ok(document.campaignTemplates.every(item=>item.width<=8192&&item.height<=8192&&item.maxDurationSeconds<=3600));
});

test("creative workspace preserves bounded creative direction, brief inputs and storyboard artifacts",()=>{
 const creativeBriefInput={title:"Test film",brief:"A verifiable workshop story.",audience:"Small businesses",channel:"YouTube",style:"Documentary",duration:"60 seconds",desiredFeeling:"Trust",differentiator:"Show the real process",proof:"A workshop demonstration",callToAction:"Visit the workshop",visualSignature:"Warm daylight",soundSignature:"Authentic ambience",constraints:"Verify all claims"};
 const creativeDNA={schemaVersion:1,title:"Test film",creativePromise:"A practical story.",storyBeats:["Problem","Process","Proof"],completenessScore:88,planningOnly:true};
 const modelCreativeDirection={schemaVersion:1,source:"model",model:"local-model",title:"Test film",creativePromise:"A grounded story.",audienceContract:"A useful story for viewers.",strategicThesis:"Lead with evidence.",emotionalJourney:["Curiosity","Proof","Confidence"],hookAngles:["Open on the work","Start with a question","Reveal a detail"],visualGrammar:["Natural light","Precise close-ups"],soundIdentity:["Authentic ambience"],storyBeats:["Problem","Process","Proof"],productionPillars:["Evidence first"],distributionCuts:["Vertical master"],proofAndTrustChecks:["Verify claims"],assumptions:[],openQuestions:["Which claim is approved?"],riskFlags:[],creativeRoutes:[{name:"Process",angle:"Follow the work",tradeoff:"Slower opening"}],generatedAt:"2026-11-14T00:00:00.000Z",inputHash:"a".repeat(64)};
 const storyboard={schemaVersion:1,source:"model",model:"local-model",title:"Test film",logline:"A process story.",generatedAt:"2026-11-14T00:00:00.000Z",inputHash:"b".repeat(64),targetDurationSeconds:20,durationSeconds:20,aspectRatio:"9:16",frameRate:24,globalContinuityRules:["Keep the set consistent","Preserve screen direction","Verify claims"],characterSuggestions:[],scenes:[{id:"scene-1",number:1,title:"Opening",slugline:"INT. WORKSHOP - DAY",purpose:"Establish the premise.",storyBeat:"Problem",location:"Workshop",timeOfDay:"Day",durationSeconds:20,shots:[{id:"shot-1",number:1,shotType:"Wide",framing:"Wide",angle:"Eye level",movement:"Static",lens:"24mm",action:"Reveal the workshop.",dialogue:"",narration:"",visualPrompt:"An editable still prompt.",motionPrompt:"An editable motion prompt.",negativePrompt:"No invented marks.",lighting:"Daylight",soundCue:"Room tone",continuityIn:"Start wide.",continuityOut:"Move to bench.",proofReference:"",transitionOut:"cut",durationSeconds:20,characterRefs:[]}]}]};
 const modelStoryboard={...storyboard,id:"model-storyboard-1"};
 const result=sanitizeCreativeWorkspaceDocument({creativeProjects:[{id:"project-1",name:"Test film",brief:"A short brief",audience:"Viewers",style:"Documentary",created:"2026-11-14",creativeBriefInput,creativeDNA,modelCreativeDirection,storyboard,modelStoryboard}]});
 const project=result.creativeProjects[0];
 assert.deepEqual(project.creativeBriefInput,creativeBriefInput);
 assert.deepEqual(project.creativeDNA,creativeDNA);
 assert.deepEqual(project.modelCreativeDirection,modelCreativeDirection);
 assert.deepEqual(project.storyboard,storyboard);
 assert.deepEqual(project.modelStoryboard,modelStoryboard);
});

test("creative workspace rejects unsafe or oversized nested project artifacts",()=>{
 assert.throws(()=>sanitizeCreativeWorkspaceDocument({creativeProjects:[{id:"p",name:"Large",storyboard:{text:"x".repeat(7000)}}]}),error=>error.code==="WORKSPACE_ARTIFACT_INVALID");
 let nested={},cursor=nested;for(let i=0;i<12;i++){cursor.child={};cursor=cursor.child;}
 assert.throws(()=>sanitizeCreativeWorkspaceDocument({creativeProjects:[{id:"p",name:"Deep",storyboard:nested}]}),error=>error.code==="WORKSPACE_ARTIFACT_INVALID");
 assert.throws(()=>sanitizeCreativeWorkspaceDocument({creativeProjects:[{id:"p",name:"Too many",storyboard:{items:Array.from({length:201},(_,i)=>i)}}]}),error=>error.code==="WORKSPACE_ARTIFACT_INVALID");
});
