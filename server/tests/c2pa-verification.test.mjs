import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createC2paVerifier } from "../c2pa-verification.mjs";

async function fixture(bytes=Buffer.from("stable media bytes"),extension=".mp4"){
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-test-")),filePath=join(dir,"asset"+extension);
 await writeFile(filePath,bytes);
 return{dir,filePath,sha256:createHash("sha256").update(bytes).digest("hex"),size:bytes.length,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
function sdkFor(store,{embedded=true,onRead=null,mimeType="video/mp4"}={}){
 class Context{constructor(settings){this.settings=settings;}}
 const Reader={async fromAsset(asset,context){
  assert.equal(asset.mimeType,mimeType);
  assert.ok(context instanceof Context);
  assert.equal(context.settings.verify.verifyAfterReading,true);
  assert.equal(context.settings.verify.remoteManifestFetch,false);
  if(onRead)await onRead(asset);
  return{isEmbedded:()=>embedded,json:()=>store};
 }};
 return{Reader,Context};
}
const validStore={
 active_manifest:"urn:uuid:active",
 validation_state:"Valid",
 manifests:{"urn:uuid:active":{
  title:"Generated sample",format:"video/mp4",claim_generator:"Executive Visuals/0.1",
  ingredients:[{title:"source.mp4",format:"video/mp4",relationship:"parentOf",instance_id:"source-1",manifest_data:{identifier:"manifest"}}]
 }},
 validation_status:[{code:"claimSignature.validated",success:true},{code:"assertion.dataHash.match",success:true}]
};

test("validates a real SDK Reader result without claiming signer trust",async()=>{
 const f=await fixture();
 try{
  const verify=createC2paVerifier({sdkLoader:async()=>sdkFor(validStore),maxBytes:1024});
  const result=await verify({filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256,expectedSize:f.size});
  assert.equal(result.status,"valid_untrusted");
  assert.equal(result.present,true);
  assert.equal(result.valid,true);
  assert.equal(result.trusted,false);
  assert.equal(result.manifest.title,"Generated sample");
  assert.equal(result.manifest.ingredientCount,1);
  assert.equal(result.validationStatuses[0].code,"claimSignature.validated");
 }finally{await f.cleanup();}
});

test("only SDK Trusted validation state is exposed as trusted",async()=>{
 const f=await fixture();
 try{
  const store={...validStore,validation_state:"Trusted"};
  const result=await createC2paVerifier({sdkLoader:async()=>sdkFor(store),maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256,expectedSize:f.size
  });
  assert.equal(result.status,"trusted");
  assert.equal(result.trusted,true);
 }finally{await f.cleanup();}
});

test("passes separately configured user trust anchors into the CAI Context",async()=>{
 const f=await fixture();
 let settings=null;
 class Context{constructor(value){settings=value;}}
 const Reader={async fromAsset(){return{isEmbedded:()=>false,json:()=>({})};}};
 try{
  const userAnchorsPath=join(f.dir,"user-anchors.pem");
  await writeFile(userAnchorsPath,"test user anchor PEM");
  const result=await createC2paVerifier({
   sdkLoader:async()=>({Reader,Context}),maxBytes:1024,userAnchorsPath
  })({filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256,expectedSize:f.size});
  assert.equal(settings?.trust?.userAnchors,"test user anchor PEM");
  assert.equal(settings?.trust?.trustAnchors,undefined);
  assert.equal(result.status,"not_present");
 }finally{await f.cleanup();}
});

test("reports missing embedded credentials separately from invalid credentials",async()=>{
 const f=await fixture();
 try{
  const verify=createC2paVerifier({sdkLoader:async()=>sdkFor({}, {embedded:false}),maxBytes:1024});
  const result=await verify({filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256});
  assert.equal(result.status,"not_present");
  assert.equal(result.present,false);
 }finally{await f.cleanup();}
});

test("fails closed when the SDK rejects a manifest-bearing asset",async()=>{
 const f=await fixture();
 try{
  const sdk=sdkFor(null);
  sdk.Reader.fromAsset=async()=>{throw new Error("untrusted parser detail");};
  const result=await createC2paVerifier({sdkLoader:async()=>sdk,maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256
  });
  assert.equal(result.status,"invalid");
  assert.deepEqual(result.findings,["C2PA_READER_REJECTED_ASSET"]);
 }finally{await f.cleanup();}
});

test("does not trust a manifest with validation failures",async()=>{
 const f=await fixture();
 try{
  const store={...validStore,validation_state:"Invalid",validation_status:[{code:"assertion.dataHash.mismatch",success:false}]};
  const result=await createC2paVerifier({sdkLoader:async()=>sdkFor(store),maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256
  });
  assert.equal(result.status,"invalid");
  assert.ok(result.findings.includes("assertion.dataHash.mismatch"));
 }finally{await f.cleanup();}
});

test("rejects files whose bytes no longer match the asset row",async()=>{
 const f=await fixture();
 try{
  await assert.rejects(createC2paVerifier({sdkLoader:async()=>sdkFor(validStore),maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:"a".repeat(64)
  }),error=>error.code==="C2PA_ASSET_INTEGRITY_MISMATCH");
 }finally{await f.cleanup();}
});

test("enforces the inspection size limit before invoking the SDK",async()=>{
 const f=await fixture(Buffer.alloc(2048,1));
 try{
  let called=false;
  await assert.rejects(createC2paVerifier({sdkLoader:async()=>{called=true;return sdkFor(validStore);},maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256
  }),error=>error.code==="C2PA_ASSET_SIZE_UNSUPPORTED");
  assert.equal(called,false);
 }finally{await f.cleanup();}
});

test("detects media mutation while the native reader is running",async()=>{
 const f=await fixture();
 try{
  const sdk=sdkFor(validStore,{onRead:()=>writeFile(f.filePath,"tampered media bytes")});
  await assert.rejects(createC2paVerifier({sdkLoader:async()=>sdk,maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256
  }),error=>error.code==="C2PA_ASSET_CHANGED_DURING_READ");
 }finally{await f.cleanup();}
});

test("reports an unavailable native SDK without weakening verification",async()=>{
 const f=await fixture();
 try{
  await assert.rejects(createC2paVerifier({sdkLoader:async()=>{throw new Error("module missing");},maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256
  }),error=>error.code==="C2PA_SDK_UNAVAILABLE"&&error.status===503);
 }finally{await f.cleanup();}
});

test("reports a remote-only manifest as unavailable instead of absent",async()=>{
 const f=await fixture();
 try{
  const sdk=sdkFor({}, {embedded:false});
  sdk.Reader.fromAsset=async()=>({isEmbedded:()=>false,remoteUrl:()=>"https://credentials.example/manifest.c2pa",json:()=>({})});
  const result=await createC2paVerifier({sdkLoader:async()=>sdk,maxBytes:1024})({
   filePath:f.filePath,mediaType:"video/mp4",expectedSha256:f.sha256
  });
  assert.equal(result.status,"validation_unavailable");
  assert.equal(result.present,true);
  assert.ok(result.findings.includes("C2PA_REMOTE_MANIFEST_FETCH_DISABLED"));
 }finally{await f.cleanup();}
});



test("inspects PDF Content Credentials using the stored PDF extension and MIME type", async () => {
 const bytes=Buffer.from("%PDF-1.7\\n% Executive Visuals C2PA verification fixture\\n");
 const f=await fixture(bytes,".pdf");
 try{
  let readerCalled=false;
  const sdk=sdkFor(validStore,{mimeType:"application/pdf",onRead:async asset=>{
   readerCalled=true;
   assert.equal(asset.path,f.filePath);
  }});
  const result=await createC2paVerifier({sdkLoader:async()=>sdk,maxBytes:1024})({
   filePath:f.filePath,mediaType:"application/pdf",expectedSha256:f.sha256,expectedSize:f.size
  });
  assert.equal(readerCalled,true);
  assert.equal(result.status,"valid_untrusted");
  assert.equal(result.present,true);
  assert.equal(result.valid,true);
  assert.equal(result.trusted,false);
 }finally{await f.cleanup();}
});

test("reports unsupported asset formats as unavailable rather than invalid", async () => {
  const f = await fixture();
  try {
    for (const mediaType of ["text/plain", "text/vtt", "application/json", "video/webm", "video/x-matroska", "audio/ogg"]) {
      let sdkLoaded = false;
      const result = await createC2paVerifier({
        sdkLoader: async () => { sdkLoaded = true; return sdkFor(validStore); },
        maxBytes: 1024
      })({ filePath: f.filePath, mediaType, expectedSha256: f.sha256, expectedSize: f.size });
      assert.equal(result.status, "validation_unavailable");
      assert.equal(result.present, null);
      assert.equal(result.valid, false);
      assert.deepEqual(result.findings, ["C2PA_FORMAT_UNSUPPORTED"]);
      assert.equal(sdkLoaded, false);
    }
  } finally { await f.cleanup(); }
});

test("normalizes MIME parameters before supported-format verification", async () => {
  const f = await fixture();
  try {
    let receivedType = "";
    const sdk = sdkFor(validStore);
    sdk.Reader.fromAsset = async (asset, context) => {
      receivedType = asset.mimeType;
      assert.ok(context instanceof sdk.Context);
      assert.equal(context.settings.verify.verifyAfterReading, true);
      return { isEmbedded: () => true, json: () => validStore };
    };
    const result = await createC2paVerifier({ sdkLoader: async () => sdk, maxBytes: 1024 })({
      filePath: f.filePath, mediaType: " VIDEO/MP4; codecs=avc1 ", expectedSha256: f.sha256
    });
    assert.equal(result.status, "valid_untrusted");
    assert.equal(receivedType, "video/mp4");
  } finally { await f.cleanup(); }
});
