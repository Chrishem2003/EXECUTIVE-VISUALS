import assert from "node:assert/strict";
import {createCipheriv,createHash,randomBytes,scryptSync} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";

const url=String(process.env.SUPABASE_URL||"").replace(/\/$/,"");
const key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||"";
const databaseUrl=process.env.SUPABASE_DB_URL||"";
const passphrase=process.env.BACKUP_ENCRYPTION_PASSPHRASE||"";
for(const [name,value] of Object.entries({SUPABASE_URL:url,SUPABASE_SECRET_KEY:key,SUPABASE_DB_URL:databaseUrl,BACKUP_ENCRYPTION_PASSPHRASE:passphrase}))if(!value)throw new Error("Missing required staging backup secret: "+name);
if(passphrase.length<24)throw new Error("Backup encryption passphrase must contain at least 24 characters.");
const bucket=process.env.STORAGE_BACKUP_BUCKET||"executive-visuals-media";
const output=resolve(process.env.BACKUP_OUTPUT_DIR||"artifacts");
const work=join(tmpdir(),"executive-visuals-backup-"+randomUUID());
const source=join(work,"source");
const objectsDir=join(source,"objects");
await mkdir(objectsDir,{recursive:true});await mkdir(output,{recursive:true});
const run=(command,args)=>{const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:16*1024*1024});if(result.status!==0)throw new Error(command+" failed: "+String(result.stderr||result.stdout).slice(0,1200));};
const headers={apikey:key,authorization:"Bearer "+key,"content-type":"application/json"};
const hash=data=>createHash("sha256").update(data).digest("hex");
try{
 const dump=join(source,"database.dump");
 run("pg_dump",["--format=custom","--no-owner","--no-acl","--file",dump,databaseUrl]);
 const entries=[];const pendingPrefixes=[""];const visitedPrefixes=new Set();
 while(pendingPrefixes.length){
  const prefix=pendingPrefixes.shift();
  if(visitedPrefixes.has(prefix))continue;
  visitedPrefixes.add(prefix);
  let offset=0;const pageSize=1000;
  while(true){
   const response=await fetch(url+"/storage/v1/object/list/"+encodeURIComponent(bucket),{
    method:"POST",headers,body:JSON.stringify({prefix,limit:pageSize,offset,sortBy:{column:"name",order:"asc"}})
   });
   const raw=await response.text();if(!response.ok)throw new Error("Storage inventory failed HTTP "+response.status+": "+raw.slice(0,300));
   const page=JSON.parse(raw);if(!Array.isArray(page))throw new Error("Unexpected Storage inventory response.");
   for(const item of page){
    if(!item?.name||item.name.includes("\\0")||item.name.includes("/")||item.name==="."||item.name==="..")throw new Error("Storage inventory returned an invalid child name.");
    const objectPath=prefix+item.name;
    if(item.id===null){
     pendingPrefixes.push(objectPath+"/");
     if(pendingPrefixes.length+visitedPrefixes.size>100000)throw new Error("Storage inventory exceeded the 100,000-folder safety limit.");
     continue;
    }
    const downloadPath=objectPath.split("/").map(encodeURIComponent).join("/");
    const get=await fetch(url+"/storage/v1/object/authenticated/"+encodeURIComponent(bucket)+"/"+downloadPath,{headers:{apikey:key,authorization:"Bearer "+key}});
    if(!get.ok)throw new Error("Storage object download failed HTTP "+get.status+" for an object in the backup set.");
    const bytes=Buffer.from(await get.arrayBuffer());
    const fileName=String(entries.length+1).padStart(8,"0")+".bin";
    await writeFile(join(objectsDir,fileName),bytes,{flag:"wx"});
    entries.push({name:objectPath,file:fileName,bytes:bytes.length,sha256:hash(bytes)});
    if(entries.length>100000)throw new Error("Storage inventory exceeded the 100,000-object safety limit.");
   }
   if(page.length<pageSize)break;
   offset+=page.length;
   if(offset>100000)throw new Error("Storage folder exceeded the 100,000-entry safety limit.");
  }
 }
 const dbBytes=await readFile(dump);
 const manifest={format:"executive-visuals-backup-v1",createdAt:new Date().toISOString(),bucket,database:{file:"database.dump",bytes:dbBytes.length,sha256:hash(dbBytes)},objects:entries};
 await writeFile(join(source,"manifest.json"),JSON.stringify(manifest,null,2));
 const archive=join(work,"backup.tar.gz");
 run("tar",["-czf",archive,"-C",source,"."]);
 const plain=await readFile(archive),salt=randomBytes(16),nonce=randomBytes(12),derived=scryptSync(passphrase,salt,32);
 const cipher=createCipheriv("aes-256-gcm",derived,nonce);
 const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
 const result=Buffer.concat([Buffer.from("EVB1"),salt,nonce,cipher.getAuthTag(),encrypted]);
 const file=join(output,"executive-visuals-staging-backup-"+new Date().toISOString().replace(/[:.]/g,"-")+".evb");
 await writeFile(file,result,{mode:0o600,flag:"wx"});
 console.log(JSON.stringify({result:"encrypted_export_created",file:file.split(/[\\/]/).pop(),databaseBytes:dbBytes.length,storageObjects:entries.length,encryptedBytes:result.length,algorithm:"AES-256-GCM",manifestSha256:hash(Buffer.from(JSON.stringify(manifest)))}));
}finally{await rm(work,{recursive:true,force:true});}
