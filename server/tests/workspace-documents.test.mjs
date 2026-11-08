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
