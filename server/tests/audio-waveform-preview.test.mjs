import test from "node:test";
import assert from "node:assert/strict";
import { createAudioWaveformPreview } from "../../src/core/audio-waveform-preview.ts";

function response(bytes,{status=200,headers={}}={}){
 const body=new ReadableStream({start(controller){controller.enqueue(Uint8Array.from(bytes));controller.close();}});
 return new Response(body,{status,headers});
}
const decoded={length:8,numberOfChannels:2,getChannelData(channel){return channel===0?Float32Array.from([0,.2,.4,.1,0,.1,.3,.2]):Float32Array.from([0,.1,.2,.8,0,.2,.1,.1]);}};

test("cloud waveform preview fetches signed media without forwarding application credentials",async()=>{
 let request;
 const svg=await createAudioWaveformPreview("https://storage.example.test/signed/audio",{fetchImpl:async(url,init)=>{request={url,init};return response([1,2,3,4]);},decodeAudioData:async data=>{assert.equal(data.byteLength,4);return decoded;},bucketCount:4});
 assert.equal(request.url,"https://storage.example.test/signed/audio");
 assert.equal(request.init.credentials,"omit");
 assert.equal(request.init.method,"GET");
 assert.match(svg,/viewBox="0 0 720 48"/);
 assert.equal((svg.match(/<rect /g)||[]).length,4);
});

test("cloud waveform preview rejects oversized responses before decoding",async()=>{
 let decodedCalled=false;
 await assert.rejects(()=>createAudioWaveformPreview("https://storage.example.test/large",{maxBytes:1024,fetchImpl:async()=>response(new Uint8Array(1025)),decodeAudioData:async()=>{decodedCalled=true;return decoded;}}),/size limit/);
 assert.equal(decodedCalled,false);
});

test("cloud waveform preview rejects failed and empty media responses",async()=>{
 await assert.rejects(()=>createAudioWaveformPreview("https://storage.example.test/missing",{fetchImpl:async()=>response([],{status:404}),decodeAudioData:async()=>decoded}),/could not be fetched/);
 await assert.rejects(()=>createAudioWaveformPreview("https://storage.example.test/empty",{fetchImpl:async()=>response([]),decodeAudioData:async()=>decoded;}),/empty/);
});

test("cloud waveform preview requires a decoder and propagates decode failures safely",async()=>{
 await assert.rejects(()=>createAudioWaveformPreview("https://storage.example.test/audio",{fetchImpl:async()=>response([1,2,3])}),/decoder is unavailable/);
 await assert.rejects(()=>createAudioWaveformPreview("https://storage.example.test/audio",{fetchImpl:async()=>response([1,2,3]),decodeAudioData:async()=>{throw new Error("decode failed");}}),/decode failed/);
});
