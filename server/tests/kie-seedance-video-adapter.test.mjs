import test from "node:test";
import assert from "node:assert/strict";
import { createKieSeedanceVideoAdapter } from "../kie-seedance-video-adapter.mjs";

const taskId="task_bytedance_1765186743319";
function client(overrides={}){return{
 model:"bytedance/seedance-2",minimumPollIntervalMs:5000,
 async submit(payload){return{taskId,status:"queued",payload};},
 async getStatus(id){return{taskId:id,status:"succeeded",creditsConsumed:205,outputUrls:["https://cdn.example.com/video.mp4"]};},
 ...overrides
};}
const dependencies={enabled:true,allowRemote:true,client:client(),ingestOutputs:async args=>({assetIds:["private-asset"],args}),resolveActualCost:async args=>({amount:1.025,currency:"USD",evidenceReference:"kie:task:"+args.providerTaskId+":credits:"+args.creditsConsumed})};

test("prepares provider-default audio-on Seedance payloads and submits through the exact adapter",async()=>{
 const adapter=createKieSeedanceVideoAdapter(dependencies);
 const prepared=await adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"A cinematic process shot",durationSeconds:5,resolution:"provider_default",aspectRatio:"9:16",audioMode:"provider_default"});
 assert.equal(prepared.payload.generate_audio,true);
 assert.equal(prepared.payload.resolution,"720p");
 assert.equal(prepared.payload.aspect_ratio,"9:16");
 const submitted=await adapter.submit(prepared);
 assert.equal(submitted.taskId,taskId);
 const status=await adapter.getStatus(taskId);
 assert.equal(status.status,"succeeded");
 assert.deepEqual(await adapter.ingestOutputs({task:status,providerTaskId:taskId}),{assetIds:["private-asset"],args:{task:status,providerTaskId:taskId,provider:"kie",model:"bytedance/seedance-2"}});
 assert.equal((await adapter.resolveActualCost({task:status,providerTaskId:taskId})).amount,1.025);
});

test("uses only owner-scoped resolved reference assets and enforces first/last frame exclusivity",async()=>{
 const adapter=createKieSeedanceVideoAdapter({...dependencies,prepareInput:async(input,context)=>({...input,referenceImageUrls:["https://private.example.com/signed-image"],ownerId:context.job.owner_id})});
 const prepared=await adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"Animate a storyboard frame",durationSeconds:5,referenceAssetIds:["asset-1"]},{job:{owner_id:"owner-1",project_id:"project-1"}});
 assert.deepEqual(prepared.payload.reference_image_urls,["https://private.example.com/signed-image"]);
 const conflict=createKieSeedanceVideoAdapter({...dependencies,prepareInput:async input=>({...input,firstFrameUrl:"https://private.example.com/first.png",referenceImageUrls:["https://private.example.com/ref.png"]})});
 await assert.rejects(conflict.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"conflicting modes",durationSeconds:5,startFrameAssetId:"asset-1",referenceAssetIds:["asset-2"]}),error=>error.code==="KIE_VIDEO_INPUT_MODE_CONFLICT");
});

test("requires a private resolver for referenced assets and validates reference duration",async()=>{
 const adapter=createKieSeedanceVideoAdapter(dependencies);
 await assert.rejects(adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"Reference me",durationSeconds:5,referenceAssetIds:["asset-1"]}),error=>error.code==="KIE_VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
 const resolver=createKieSeedanceVideoAdapter({...dependencies,prepareInput:async input=>({...input,referenceVideoUrls:["https://private.example.com/ref.mp4"],referenceVideoDurationSeconds:16})});
 await assert.rejects(resolver.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"Reference video",durationSeconds:5,referenceVideoAssetIds:["asset-video"]}),error=>error.code==="KIE_VIDEO_CAPABILITY_UNSUPPORTED");
});

test("rejects model mismatch, unsafe URLs and unsupported duration or aspect ratio",async()=>{
 const adapter=createKieSeedanceVideoAdapter(dependencies);
 await assert.rejects(adapter.prepareInput({provider:"google",model:"gemini-omni-1.1-flash",prompt:"wrong",durationSeconds:5}),error=>error.code==="VIDEO_JOB_INPUT_MISMATCH");
 await assert.rejects(adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"bad",durationSeconds:3}),error=>error.code==="KIE_VIDEO_INPUT_INVALID");
 await assert.rejects(adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"unsupported",durationSeconds:5,referenceVideoAssetIds:["asset-video"]}),error=>error.code==="KIE_VIDEO_CAPABILITY_UNSUPPORTED");
 await assert.rejects(adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"unsupported",durationSeconds:5,negativePrompt:"no"}),error=>error.code==="KIE_VIDEO_CAPABILITY_UNSUPPORTED");
 await assert.rejects(adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"unsupported",durationSeconds:5,audioMode:"reference"}),error=>error.code==="KIE_VIDEO_INPUT_INVALID");
 await assert.rejects(adapter.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"unsupported",durationSeconds:5,outputFormat:"mov"}),error=>error.code==="KIE_VIDEO_INPUT_INVALID");
 const unsafe=createKieSeedanceVideoAdapter({...dependencies,prepareInput:async input=>({...input,firstFrameUrl:"https://127.0.0.1/private.png"})});
 await assert.rejects(unsafe.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"bad url",durationSeconds:5,firstFrameAssetId:"asset-1"}),error=>error.code==="KIE_VIDEO_INPUT_INVALID");
});

test("fails closed unless both global and provider-specific remote gates are enabled",async()=>{
 const disabled=createKieSeedanceVideoAdapter({...dependencies,enabled:false});
 await assert.rejects(disabled.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"no",durationSeconds:5}),error=>error.code==="VIDEO_GATEWAY_DISABLED");
 const remote=createKieSeedanceVideoAdapter({...dependencies,allowRemote:false});
 await assert.rejects(remote.prepareInput({provider:"kie",model:"bytedance/seedance-2",prompt:"no",durationSeconds:5}),error=>error.code==="KIE_VIDEO_REMOTE_DISABLED");
});
