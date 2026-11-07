import test from "node:test";
import assert from "node:assert/strict";
import {buildGeminiImageRequest,generateGeminiImage,listGeminiImageModels} from "../gemini-image-gateway.mjs";

test("Nano Banana Pro catalog uses the official Gemini model ID",()=>{
 const models=listGeminiImageModels();
 assert.equal(models[0].id,"gemini-3-pro-image");
 assert.deepEqual(models[0].resolutions,["1K","2K","4K"]);
 assert.equal(models[1].id,"gemini-3.1-flash-image");
 assert.deepEqual(models[1].resolutions,["1K","2K","4K"]);
});
test("Nano Banana 2 request selects the official Flash Image model ID",()=>{
 const request=buildGeminiImageRequest({model:"gemini-3.1-flash-image",prompt:"A quick social campaign",quality:"medium"});
 assert.equal(request.model,"gemini-3.1-flash-image");
 assert.deepEqual(request.body.generationConfig.imageConfig,{aspectRatio:"1:1",imageSize:"1K"});
});
test("request maps output size and quality to documented aspect ratio and image size",()=>{
 const request=buildGeminiImageRequest({prompt:"A premium product campaign",size:"1536x1024",quality:"high"});
 assert.equal(request.model,"gemini-3-pro-image");
 assert.deepEqual(request.body.generationConfig.imageConfig,{aspectRatio:"3:2",imageSize:"2K"});
 assert.deepEqual(request.body.generationConfig.responseModalities,["IMAGE"]);
});
test("request includes one validated inline reference image",()=>{
 const reference="data:image/png;base64,iVBORw0KGgo=";
 const request=buildGeminiImageRequest({prompt:"Preserve this product",referenceImageDataUrl:reference});
 assert.deepEqual(request.body.contents[0].parts[1],{inline_data:{mime_type:"image/png",data:"iVBORw0KGgo="}});
});
test("rejects invalid prompt and malformed reference data",()=>{
 assert.throws(()=>buildGeminiImageRequest({prompt:""}),e=>e.code==="IMAGE_GATEWAY_INVALID_INPUT");
 assert.throws(()=>buildGeminiImageRequest({prompt:"A test",referenceImageDataUrl:"https://example.com/image.png"}),e=>e.code==="IMAGE_GATEWAY_INVALID_INPUT");
});
test("remote calls remain disabled unless explicitly enabled",async()=>{
 const previous={enabled:process.env.IMAGE_GATEWAY_ENABLED,remote:process.env.IMAGE_GATEWAY_ALLOW_REMOTE,key:process.env.GEMINI_API_KEY};
 process.env.IMAGE_GATEWAY_ENABLED="true";process.env.IMAGE_GATEWAY_ALLOW_REMOTE="false";process.env.GEMINI_API_KEY="test";
 await assert.rejects(()=>generateGeminiImage({prompt:"A test"}),e=>e.code==="IMAGE_GATEWAY_REMOTE_DISABLED");
 for(const [key,value] of Object.entries({IMAGE_GATEWAY_ENABLED:previous.enabled,IMAGE_GATEWAY_ALLOW_REMOTE:previous.remote,GEMINI_API_KEY:previous.key}))if(value===undefined)delete process.env[key];else process.env[key]=value;
});
test("fake Gemini response returns verified image bytes without contacting a live API",async()=>{
 const previous={enabled:process.env.IMAGE_GATEWAY_ENABLED,remote:process.env.IMAGE_GATEWAY_ALLOW_REMOTE,key:process.env.GEMINI_API_KEY,model:process.env.GEMINI_IMAGE_MODEL};
 process.env.IMAGE_GATEWAY_ENABLED="true";process.env.IMAGE_GATEWAY_ALLOW_REMOTE="true";process.env.GEMINI_API_KEY="test";process.env.GEMINI_IMAGE_MODEL="gemini-3-pro-image";
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 const fetchImpl=async(url,options)=>{assert.equal(String(url),"https://generativelanguage.googleapis.com/v1/models/gemini-3-pro-image:generateContent");assert.equal(options.headers["x-goog-api-key"],"test");return new Response(JSON.stringify({candidates:[{content:{parts:[{inlineData:{mimeType:"image/png",data:png.toString("base64")}}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:20,totalTokenCount:30}}),{status:200});};
 const result=await generateGeminiImage({prompt:"A studio product image",fetchImpl});
 assert.equal(result.model,"gemini-3-pro-image");assert.equal(result.buffer.toString("hex"),png.toString("hex"));assert.equal(result.usage.totalTokens,30);
 for(const [key,value] of Object.entries({IMAGE_GATEWAY_ENABLED:previous.enabled,IMAGE_GATEWAY_ALLOW_REMOTE:previous.remote,GEMINI_API_KEY:previous.key,GEMINI_IMAGE_MODEL:previous.model}))if(value===undefined)delete process.env[key];else process.env[key]=value;
});
