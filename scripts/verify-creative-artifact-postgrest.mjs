import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createCloudCreativeProjectArtifactRepository } from "../server/creative-project-artifacts-postgres.mjs";

const base=(process.env.POSTGREST_URL||"http://127.0.0.1:3000").replace(/\/$/,"");
const secret=process.env.PGRST_JWT_SECRET;
assert.ok(secret&&secret.length>=32,"PGRST_JWT_SECRET must contain at least 32 characters");
const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const reviewer="323e4567-e89b-42d3-a456-426614174000";
const projectId="423e4567-e89b-42d3-a456-426614174002";
const encode=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
function token(role){
 const now=Math.floor(Date.now()/1000),header=encode({alg:"HS256",typ:"JWT"}),payload=encode({role,iss:"supabase",iat:now,exp:now+300});
 const unsigned=header+"."+payload,signature=createHmac("sha256",secret).update(unsigned).digest("base64url");
 return unsigned+"."+signature;
}
const hash=value=>createHash("sha256").update(value,"utf8").digest("hex");
const input={brief:"A verified community solar workshop"};
const inputHash=hash("postgrest-brief-v1");
const storyboard=()=>({
 schemaVersion:1,source:"model",id:"postgrest-board",model:"ci-model",generatedAt:"2026-11-19T10:00:00.000Z",
 inputHash,title:"Community solar workshop",logline:"A practical, evidence-led workshop.",targetDurationSeconds:30,durationSeconds:30,
 aspectRatio:"9:16",frameRate:30,globalContinuityRules:["Keep workshop layout consistent","Preserve equipment geometry","Maintain screen direction"],
 characterSuggestions:[],scenes:[1,2].map(number=>({
  id:"scene-"+number,number,title:"Scene "+number,slugline:"INT. WORKSHOP - DAY",purpose:"Show a verified process",storyBeat:"Proof",
  location:"Workshop",timeOfDay:"Day",durationSeconds:15,shots:[{
   id:"shot-"+number,number:1,shotType:"Detail",framing:"Close-up",angle:"Eye level",movement:"Slow push",lens:"50mm",
   action:"Show the verified step.",dialogue:"",narration:"",visualPrompt:"Workshop detail.",motionPrompt:"Slow movement.",
   negativePrompt:"No invented claims.",lighting:"Soft daylight",soundCue:"Room tone",continuityIn:"Match previous scene.",
   continuityOut:"Hold on the result.",proofReference:"Check source evidence.",transitionOut:"cut",durationSeconds:15,characterRefs:[]
  }]
 }))
});

const anonymous=await fetch(base+"/rest/v1/creative_project_artifacts?select=id",{headers:{"accept-profile":"executive_visuals"}});
assert.ok(!anonymous.ok,"anon role must not read creative artifact records");
const authenticated=await fetch(base+"/rest/v1/creative_project_artifacts?select=id",{headers:{"accept-profile":"executive_visuals",authorization:"Bearer "+token("authenticated")}});
assert.ok(!authenticated.ok,"authenticated role must not read creative artifact records");

const repository=createCloudCreativeProjectArtifactRepository({url:base,serviceRoleKey:token("service_role")});
const ready=await repository.checkReadiness();
assert.equal(ready.ready,true);
assert.equal(await repository.assertWriter({projectId,ownerId:owner,createdBy:owner,projectName:"Creative artifact integration"}),true);
assert.equal(await repository.assertWriter({projectId,ownerId:owner,createdBy:editor,projectName:"Creative artifact integration"}),true);
await assert.rejects(()=>repository.assertWriter({projectId,ownerId:owner,createdBy:reviewer,projectName:"Creative artifact integration"}),error=>error.code==="CREATIVE_ARTIFACT_EDITOR_REQUIRED");

const direction=await repository.save({projectId,ownerId:owner,projectName:"Creative artifact integration",createdBy:owner,type:"creative_direction",input,content:{schemaVersion:1,title:"Evidence-led creative direction",proofChecks:["Confirm source footage"]},inputHash,model:"ci-model",usage:{totalTokens:20}});
assert.equal(direction.revision,1);
assert.equal(direction.type,"creative_direction");

const original=storyboard();
const board=await repository.save({projectId,ownerId:owner,projectName:"Creative artifact integration",createdBy:owner,type:"storyboard",input,content:original,inputHash,model:"ci-model",usage:{totalTokens:30}});
assert.equal(board.revision,1);
const edited=storyboard();edited.scenes[0].shots[0].action="Show the inspected solar controller.";
const revision=await repository.appendRevision({projectId,ownerId:owner,projectName:"Creative artifact integration",createdBy:editor,artifactId:board.id,content:edited});
assert.equal(revision.revision,2);
assert.equal(revision.inputHash,inputHash);
assert.equal(revision.content.scenes[0].shots[0].action,"Show the inspected solar controller.");
const noOp=await repository.appendRevision({projectId,ownerId:owner,projectName:"Creative artifact integration",createdBy:editor,artifactId:revision.id,content:edited});
assert.equal(noOp.unchanged,true);
assert.equal(noOp.id,revision.id);
const fetched=await repository.get({projectId,artifactId:revision.id});
assert.equal(fetched.contentHash,revision.contentHash);
const boards=await repository.list({projectId,type:"storyboard",limit:10});
assert.deepEqual(boards.map(item=>item.revision).sort((a,b)=>a-b),[1,2]);
const all=await repository.list({projectId,limit:10});
assert.equal(all.length,3);
console.log("PostgREST creative artifact HTTP integration passed: service-role auth, schema profile, project scope, owner/editor permissions, immutable revisions and reads.");
