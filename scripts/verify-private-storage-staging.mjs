import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";

const required=["SUPABASE_URL","SUPABASE_ANON_KEY","STORAGE_TEST_OWNER_JWT","STORAGE_TEST_OTHER_JWT","STORAGE_TEST_OWNER_ID"];
for(const key of required) if(!process.env[key]) throw new Error("Missing required staging acceptance secret: "+key);
const base=process.env.SUPABASE_URL.replace(/\/$/,"");
const bucket=process.env.STORAGE_TEST_BUCKET||"executive-visuals-media";
const ownerId=process.env.STORAGE_TEST_OWNER_ID;
const ownerJwt=process.env.STORAGE_TEST_OWNER_JWT;
const otherJwt=process.env.STORAGE_TEST_OTHER_JWT;
const anon=process.env.SUPABASE_ANON_KEY;
const objectPath=ownerId+"/acceptance/"+randomUUID()+".bin";
const payload=Buffer.from("executive-visuals-private-storage-acceptance\n"+randomUUID(),"utf8");
const expected=createHash("sha256").update(payload).digest("hex");
const headers=jwt=>({apikey:anon,authorization:"Bearer "+jwt});
const endpoint=(suffix)=>base+"/storage/v1/"+suffix;
let uploaded=false;
async function request(url,options){const r=await fetch(url,{...options,redirect:"manual"});return r;}
try{
 const put=await request(endpoint("object/"+bucket+"/"+objectPath),{
  method:"POST",headers:{...headers(ownerJwt),"content-type":"application/octet-stream","x-upsert":"false"},body:payload
 });
 assert.ok(put.ok,"owner upload denied: HTTP "+put.status+" "+(await put.text()).slice(0,300));uploaded=true;
 const ownerGet=await request(endpoint("object/authenticated/"+bucket+"/"+objectPath),{headers:headers(ownerJwt)});
 assert.equal(ownerGet.status,200,"owner authenticated download failed: HTTP "+ownerGet.status);
 const ownerBytes=Buffer.from(await ownerGet.arrayBuffer());
 assert.equal(createHash("sha256").update(ownerBytes).digest("hex"),expected,"download checksum mismatch");
 const otherGet=await request(endpoint("object/authenticated/"+bucket+"/"+objectPath),{headers:headers(otherJwt)});
 assert.ok([400,401,403,404].includes(otherGet.status),"cross-tenant download unexpectedly succeeded: HTTP "+otherGet.status);
 const publicGet=await request(endpoint("object/public/"+bucket+"/"+objectPath),{headers:{apikey:anon}});
 assert.ok(!publicGet.ok,"private object unexpectedly available through public URL");
 const signed=await request(endpoint("object/sign/"+bucket+"/"+objectPath),{
  method:"POST",headers:{...headers(ownerJwt),"content-type":"application/json"},
  body:JSON.stringify({expiresIn:60})
 });
 assert.equal(signed.status,200,"owner signed URL creation failed: HTTP "+signed.status);
 const signedBody=await signed.json();
 const signedPath=signedBody.signedURL||signedBody.signedUrl;
 assert.ok(typeof signedPath==="string"&&signedPath.length>0,"signed URL response missing URL");
 const signedUrl=new URL(signedPath,base).toString();
 const signedGet=await request(signedUrl,{headers:{apikey:anon}});
 assert.equal(signedGet.status,200,"signed URL download failed: HTTP "+signedGet.status);
 const signedBytes=Buffer.from(await signedGet.arrayBuffer());
 assert.equal(createHash("sha256").update(signedBytes).digest("hex"),expected,"signed URL checksum mismatch");
 console.log(JSON.stringify({result:"passed",bucket,ownerUpload:true,ownerDownload:true,checksum:true,otherTenantDenied:true,publicUrlDenied:true,signedUrlDownload:true,objectPath}));
}finally{
 if(uploaded){
  const del=await request(endpoint("object/"+bucket),{
   method:"DELETE",headers:{...headers(ownerJwt),"content-type":"application/json"},
   body:JSON.stringify({prefixes:[objectPath]})
  });
  assert.ok(del.ok,"test object cleanup failed: HTTP "+del.status);
 }
}
