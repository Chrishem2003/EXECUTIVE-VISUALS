import {createCipheriv,createHash,randomBytes,scryptSync,randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir,readFile,rm,stat,writeFile} from "node:fs/promises";
import {createReadStream,createWriteStream} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import {supabaseServerAuthHeaders} from "../server/supabase-server-credentials.mjs";

export const APPROVED_STAGING_PROJECT_REF="bokxljngydmqrmktofwm";
const DEFAULT_BUCKET="executive-visuals-media";
const PAGE_SIZE=100;
const MAX_OBJECTS=100000;
const MAX_OBJECT_BYTES=1024*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256=data=>createHash("sha256").update(data).digest("hex");

function config(env){
 const required=["SUPABASE_STAGING_URL","SUPABASE_STAGING_SECRET_KEY","SUPABASE_STAGING_DB_URL","STAGING_BACKUP_ENCRYPTION_PASSPHRASE"];
 const missing=required.filter(name=>!String(env[name]||"").trim());
 if(missing.length)throw Object.assign(new Error("Required staging backup configuration is incomplete."),{code:"STAGING_BACKUP_CONFIG_MISSING",missing});
 const api=new URL(env.SUPABASE_STAGING_URL);
 if(api.protocol!=="https:"||api.hostname!==APPROVED_STAGING_PROJECT_REF+".supabase.co"||api.username||api.password||api.search||api.hash)
  throw Object.assign(new Error("Backup export is restricted to the approved staging Supabase project."),{code:"STAGING_BACKUP_PROJECT_INVALID"});
 const database=new URL(env.SUPABASE_STAGING_DB_URL);
 const dbUser=decodeURIComponent(database.username);
 const dbDirect=database.hostname==="db."+APPROVED_STAGING_PROJECT_REF+".supabase.co";
 const dbPooler=database.hostname.endsWith(".pooler.supabase.com")&&dbUser.endsWith("."+APPROVED_STAGING_PROJECT_REF);
 const dbMatches=database.protocol.startsWith("postgres")&&(dbDirect||dbPooler);
 if(!dbMatches||!database.password)
  throw Object.assign(new Error("Backup database connection does not identify the approved staging project."),{code:"STAGING_BACKUP_DATABASE_INVALID"});
 const passphrase=String(env.STAGING_BACKUP_ENCRYPTION_PASSPHRASE);
 if(passphrase.length<24)throw Object.assign(new Error("Staging backup encryption passphrase is too short."),{code:"STAGING_BACKUP_PASSPHRASE_WEAK"});
 const bucket=String(env.STORAGE_BACKUP_BUCKET||DEFAULT_BUCKET);
 if(!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)||bucket.includes(".."))
  throw Object.assign(new Error("Staging backup bucket identifier is invalid."),{code:"STAGING_BACKUP_BUCKET_INVALID"});
 database.searchParams.set("sslmode","require");
 const password=decodeURIComponent(database.password);
 database.password="";
 return {origin:api.origin,key:env.SUPABASE_STAGING_SECRET_KEY,databaseUrl:database.toString(),databasePassword:password,
  passphrase,bucket,output:resolve(env.BACKUP_OUTPUT_DIR||"artifacts")};
}

function run(command,args,{env=process.env}={}){
 const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:16*1024*1024,env,stdio:["ignore","ignore","pipe"]});
 if(result.error||result.status!==0)throw Object.assign(new Error(command+" failed during staging backup export."),{code:"STAGING_BACKUP_COMMAND_FAILED"});
}

function safeObjectPath(value){
 if(typeof value!=="string"||value.length>1024||value.startsWith("/")||value.includes("\\")||value.includes("\0"))
  throw new Error("Storage inventory returned an unsafe object path.");
 const parts=value.split("/");
 if(parts.length<3||parts.length>12||!UUID.test(parts[0])||!UUID.test(parts[1])||
   parts.some(part=>!part||part==="."||part===".."||!/^[A-Za-z0-9._-]{1,180}$/.test(part)))
  throw new Error("Storage inventory returned an object outside the owner/asset path contract.");
 return parts.join("/");
}

async function listPrivateObjects(origin,key,bucket,fetchImpl){
 const headers={...supabaseServerAuthHeaders(key),"content-type":"application/json",accept:"application/json"};
 const entries=[];const visited=new Set();
 async function walk(prefix,depth){
  if(depth>12)throw new Error("Storage inventory exceeded the supported folder depth.");
  if(visited.has(prefix))throw new Error("Storage inventory returned a recursive folder cycle.");
  visited.add(prefix);
  let offset=0;
  while(true){
   const response=await fetchImpl(origin+"/storage/v1/object/list/"+encodeURIComponent(bucket),{
    method:"POST",headers,body:JSON.stringify({prefix,limit:PAGE_SIZE,offset,sortBy:{column:"name",order:"asc"}}),redirect:"error"
   });
   if(!response.ok)throw Object.assign(new Error("Private storage inventory failed (HTTP "+response.status+")."),{code:"STAGING_BACKUP_STORAGE_LIST_FAILED"});
   let page;try{page=await response.json();}catch{throw new Error("Private storage inventory returned invalid JSON.");}
   if(!Array.isArray(page))throw new Error("Private storage inventory returned an invalid page.");
   for(const item of page){
    const name=String(item?.name||"");
    if(!name||name.includes("/")||name.includes("\\")||name==="."||name===".."||/[\u0000-\u001f\u007f]/.test(name))
     throw new Error("Private storage inventory returned an unsafe path segment.");
    const objectPath=prefix+name;
    if(item.id===null||item.id===undefined){
     await walk(objectPath+"/",depth+1);
    }else{
     safeObjectPath(objectPath);
     entries.push({name:objectPath});
     if(entries.length>MAX_OBJECTS)throw new Error("Storage inventory exceeded the 100,000-object safety limit.");
    }
   }
   if(page.length<PAGE_SIZE)break;
   offset+=page.length;
  }
  visited.delete(prefix);
 }
 await walk("",0);
 entries.sort((a,b)=>a.name.localeCompare(b.name));
 return entries;
}

async function downloadObject(origin,key,bucket,objectPath,filePath,fetchImpl){
 const encoded=objectPath.split("/").map(encodeURIComponent).join("/");
 const response=await fetchImpl(origin+"/storage/v1/object/authenticated/"+encodeURIComponent(bucket)+"/"+encoded,{
  method:"GET",headers:supabaseServerAuthHeaders(key),redirect:"error"
 });
 if(!response.ok||!response.body)throw Object.assign(new Error("A private storage object could not be downloaded for backup (HTTP "+response.status+")."),{code:"STAGING_BACKUP_OBJECT_DOWNLOAD_FAILED"});
 const declared=Number(response.headers.get("content-length"));
 if(Number.isFinite(declared)&&declared>MAX_OBJECT_BYTES)throw new Error("A private storage object exceeds the backup safety limit.");
 const hash=createHash("sha256");let size=0;
 const meter=new Transform({transform(chunk,encoding,callback){
  size+=chunk.length;
  if(size>MAX_OBJECT_BYTES){callback(Object.assign(new Error("A private storage object exceeds the backup safety limit."),{code:"STAGING_BACKUP_OBJECT_TOO_LARGE"}));return;}
  hash.update(chunk);callback(null,chunk);
 }});
 await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(filePath,{flags:"wx",mode:0o600}));
 return {bytes:size,sha256:hash.digest("hex")};
}

async function hashFile(filePath){\n const hash=createHash("sha256");let size=0;\n for await(const chunk of createReadStream(filePath)){size+=chunk.length;hash.update(chunk);}\n return{bytes:size,sha256:hash.digest("hex")};\n}\n\nexport async function createEncryptedStagingBackup({env=process.env,fetchImpl=globalThis.fetch,runCommand=run}={}){
 const c=config(env);
 const work=join(tmpdir(),"executive-visuals-backup-"+randomUUID());
 const source=join(work,"source"),objectsDir=join(source,"objects");
 await mkdir(objectsDir,{recursive:true});await mkdir(c.output,{recursive:true});
 try{
  const serverHeaders={...supabaseServerAuthHeaders(c.key),accept:"application/json"};
  const bucketResponse=await fetchImpl(c.origin+"/storage/v1/bucket/"+encodeURIComponent(c.bucket),{
   method:"GET",headers:serverHeaders,redirect:"error"
  });
  if(!bucketResponse.ok)throw Object.assign(new Error("The staging backup bucket could not be inspected."),{code:"STAGING_BACKUP_BUCKET_LOOKUP_FAILED"});
  let bucketInfo;try{bucketInfo=await bucketResponse.json();}catch{throw new Error("The staging backup bucket response was invalid.");}
  if(bucketInfo?.id!==c.bucket||bucketInfo?.public!==false)
   throw Object.assign(new Error("Backup export requires the configured staging bucket to be private."),{code:"STAGING_BACKUP_BUCKET_NOT_PRIVATE"});

  const dump=join(source,"database.dump");
  const childEnv={...process.env,PGPASSWORD:c.databasePassword,PGSSLMODE:"require"};
  runCommand("pg_dump",["--format=custom","--no-owner","--no-acl","--file",dump,"--dbname",c.databaseUrl],{env:childEnv});
  const objectEntries=await listPrivateObjects(c.origin,c.key,c.bucket,fetchImpl);
  const manifestEntries=[];
  for(let index=0;index<objectEntries.length;index++){
   const entry=objectEntries[index];
   const file=String(index+1).padStart(8,"0")+".bin";
   const result=await downloadObject(c.origin,c.key,c.bucket,entry.name,join(objectsDir,file),fetchImpl);
   manifestEntries.push({name:entry.name,file,bytes:result.bytes,sha256:result.sha256});
  }
  const dbBytes=await readFile(dump);
  const manifest={format:"executive-visuals-backup-v1",createdAt:new Date().toISOString(),bucket:c.bucket,
   database:{file:"database.dump",bytes:dbBytes.length,sha256:sha256(dbBytes)},objects:manifestEntries};
  await writeFile(join(source,"manifest.json"),JSON.stringify(manifest,null,2),{mode:0o600,flag:"wx"});
  const archive=join(work,"backup.tar.gz");
  runCommand("tar",["-czf",archive,"-C",source,"."],{env:process.env});
  const plain=await readFile(archive),salt=randomBytes(16),nonce=randomBytes(12),derived=scryptSync(c.passphrase,salt,32);
  const cipher=createCipheriv("aes-256-gcm",derived,nonce);
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  const result=Buffer.concat([Buffer.from("EVB1"),salt,nonce,cipher.getAuthTag(),encrypted]);
  const file=join(c.output,"executive-visuals-staging-backup-"+new Date().toISOString().replace(/[:.]/g,"-")+".evb");
  await writeFile(file,result,{mode:0o600,flag:"wx"});
  return {result:"encrypted_export_created",file:file.split(/[\\/]/).pop(),databaseBytes:dbBytes.length,
   storageObjects:manifestEntries.length,encryptedBytes:result.length,algorithm:"AES-256-GCM",credentialValuesExposed:false};
 }finally{await rm(work,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 createEncryptedStagingBackup().then(report=>console.log(JSON.stringify(report))).catch(error=>{
  console.log(JSON.stringify({result:"failed",code:error?.code||"STAGING_BACKUP_FAILED",
   missing:error?.missing||undefined,credentialValuesExposed:false}));
  process.exitCode=1;
 });
}
