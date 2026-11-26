import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeMeasuredPrivateAssetDownload } from "../asset-egress-stream.mjs";

const asset={id:"323e4567-e89b-42d3-a456-426614174000",ownerId:"123e4567-e89b-42d3-a456-426614174000",projectId:null,size:8};
function response(status=200,body=Buffer.from("12345678"),headers={}){
 return {status,body:Readable.from(Array.from({length:Math.ceil(body.length/4)},(_,i)=>body.subarray(i*4,(i+1)*4))),headers:{get(name){return headers[name]??(name==="content-type"?"video/mp4":null);}}};
}
function output({failAfter=null}={}){
 const chunks=[];let count=0;
 const res=new Writable({
  write(chunk,encoding,callback){if(failAfter!==null&&count+chunk.length>failAfter){callback(new Error("client disconnected"));return;}count+=chunk.length;chunks.push(Buffer.from(chunk));callback();}
 });
 res.setHeader=()=>{};res.headersSent=true;res.destroyed=false;res.statusCode=200;
 return {res,chunks,get bytes(){return Buffer.concat(chunks).length;}};
}
test("records exact bytes streamed through a successful private response",async()=>{
 const out=output(),events=[];
 const result=await pipeMeasuredPrivateAssetDownload({upstream:response(),response:out.res,asset,transferId:"423e4567-e89b-42d3-a456-426614174000",now:()=>new Date("2026-11-26T00:00:00.000Z"),record:async event=>events.push(event)});
 assert.equal(result.transferredBytes,8);assert.equal(out.bytes,8);assert.equal(events.length,1);
 assert.equal(events[0].measurement.quantity,0.000000008);
 assert.equal(events[0].measurement.dimensions.transferredBytes,8);
 assert.equal(events[0].measurement.evidenceMeasurement,"completed_private_asset_http_response");
 assert.equal(events[0].measurement.measuredAt,"2026-11-26T00:00:00.000Z");
});
test("records a smaller actual range response rather than the full asset size",async()=>{
 const out=output(),events=[];
 const result=await pipeMeasuredPrivateAssetDownload({upstream:response(206,Buffer.from("123"),{"content-length":"3","content-range":"bytes 0-2/8"}),response:out.res,asset,record:async event=>events.push(event)});
 assert.equal(result.transferredBytes,3);assert.equal(result.partial,true);
 assert.equal(events[0].measurement.dimensions.transferredBytes,3);
});
test("records bytes already streamed when the client disconnects",async()=>{
 const out=output({failAfter:4}),events=[];
 const result=await pipeMeasuredPrivateAssetDownload({upstream:response(),response:out.res,asset,record:async event=>events.push(event)});
 assert.ok(result.error);assert.equal(events.length,1);
 assert.equal(events[0].measurement.dimensions.transferredBytes,8);
 assert.equal(events[0].measurement.dimensions.partial,true);
});
test("does not record a zero-byte or unsuccessful upstream response",async()=>{
 const out=output(),events=[];
 await assert.rejects(()=>pipeMeasuredPrivateAssetDownload({upstream:response(403),response:out.res,asset,record:async event=>events.push(event)}),e=>e.code==="PRIVATE_ASSET_DOWNLOAD_UPSTREAM_INVALID");
 assert.equal(events.length,0);
});
test("rejects a response that would transfer more bytes than the asset metadata permits",async()=>{
 const out=output(),events=[];
 await assert.rejects(()=>pipeMeasuredPrivateAssetDownload({upstream:response(200,Buffer.from("123456789")),response:out.res,asset,record:async event=>events.push(event)}),e=>e.code==="PRIVATE_ASSET_DOWNLOAD_SIZE_MISMATCH");
 assert.equal(events.length,0);
});
