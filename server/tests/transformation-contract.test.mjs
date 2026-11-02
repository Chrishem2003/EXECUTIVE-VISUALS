import test from "node:test";
import assert from "node:assert/strict";
import { assertTransformationCapabilities, createTransformationProvenance, normalizeVideoTransformationRequest, VideoTransformationValidationError } from "../transformation-contract.mjs";
const sourceAsset={id:"source-video-1",media_type:"video/mp4",sha256:"a".repeat(64)};
const consent={rightsConfirmed:true,subjectConsentConfirmed:true};
const base={sourceAsset,operation:"vehicle_replace",targetDescription:"Replace the blue hatchback with a metallic graphite electric SUV",prompt:"Replace only the vehicle. Match perspective, reflections, lighting and road contact.",consent};
test("normalizes a vehicle transformation into a provider-neutral, non-executing request",()=>{
 const request=normalizeVideoTransformationRequest(base);
 assert.equal(request.operation,"vehicle_replace");
 assert.equal(request.sourceAsset.id,sourceAsset.id);
 assert.deepEqual(request.preserve,["camera_motion","timing","composition","source_audio"]);
 assert.equal(request.durationSeconds,5);
 assert.equal(request.execution.mode,"draft");
 assert.equal(request.execution.submitted,false);
 assert.equal(request.execution.requiresApproval,true);
});
test("supports wardrobe, object, background and style transformations",()=>{
 for(const operation of ["wardrobe_replace","object_replace","background_replace","style_transfer","object_remove","relight"])
  assert.equal(normalizeVideoTransformationRequest({...base,operation}).operation,operation);
});
test("rejects malformed inputs, unsafe durations, excessive references and unknown fields",()=>{
 const invalid=[null,{...base,sourceAsset:null},{...base,sourceAsset:{id:"bad",media_type:"image/png"}},{...base,operation:"face_swap"},{...base,targetDescription:""},{...base,prompt:"x".repeat(6001)},{...base,durationSeconds:31},{...base,durationSeconds:1.5},{...base,referenceAssetIds:Array.from({length:5},(_,i)=>"ref-"+i)},{...base,referenceAssetIds:["same","same"]},{...base,untrustedProviderUrl:"https://example.test"}];
 for(const input of invalid)assert.throws(()=>normalizeVideoTransformationRequest(input),VideoTransformationValidationError);
});
test("requires explicit rights and additional subject consent for person replacement",()=>{
 assert.throws(()=>normalizeVideoTransformationRequest({...base,consent:{rightsConfirmed:false,subjectConsentConfirmed:true}}),e=>e.code==="VIDEO_TRANSFORM_RIGHTS_REQUIRED");
 assert.throws(()=>normalizeVideoTransformationRequest({...base,operation:"person_replace",consent:{rightsConfirmed:true}}),e=>e.code==="VIDEO_TRANSFORM_SUBJECT_CONSENT_REQUIRED");
});
test("rejects providers that do not declare requested transformation or preservation behavior",()=>{
 const request=normalizeVideoTransformationRequest(base);
 assert.throws(()=>assertTransformationCapabilities(request,{operations:["wardrobe_replace"]}),e=>e.code==="VIDEO_TRANSFORM_UNSUPPORTED_CAPABILITY");
 assert.throws(()=>assertTransformationCapabilities(request,{operations:["vehicle_replace"],maxDurationSeconds:10,maxReferenceImages:4,preserves:["timing","composition","source_audio"]}),e=>e.code==="VIDEO_TRANSFORM_UNSUPPORTED_PRESERVATION");
});
test("accepts only capabilities explicitly declared by the selected adapter",()=>{
 const request=normalizeVideoTransformationRequest({...base,referenceAssetIds:["vehicle-front","vehicle-side"],durationSeconds:8});
 assert.equal(assertTransformationCapabilities(request,{operations:["vehicle_replace"],maxDurationSeconds:10,maxReferenceImages:4,preserves:["camera_motion","timing","composition","source_audio"]}),true);
});
test("requires explicit subject consent for person replacement even with technical capability",()=>{
 const request=normalizeVideoTransformationRequest({...base,operation:"person_replace",consent:{rightsConfirmed:true,subjectConsentConfirmed:true}});
 assert.equal(assertTransformationCapabilities(request,{operations:["person_replace"],maxDurationSeconds:10,maxReferenceImages:4,preserves:["camera_motion","timing","composition","source_audio"]}),true);
});

test("records source lineage and a stable hash from a normalized draft",()=>{
 const request=normalizeVideoTransformationRequest({...base,requestId:"transform-1"});
 const provenance=createTransformationProvenance(request,{provider:"unselected",model:"unselected"});
 assert.equal(provenance.requestId,"transform-1");
 assert.equal(provenance.sourceAssetId,sourceAsset.id);
 assert.equal(provenance.sourceSha256,sourceAsset.sha256);
 assert.equal(provenance.executionSubmitted,false);
 assert.match(provenance.requestHash,/^[a-f0-9]{64}$/);
});
