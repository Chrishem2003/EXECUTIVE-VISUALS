import {createDecipheriv,createHash,scryptSync,randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir,open,readdir,rm,stat,readFile} from "node:fs/promises";
import {createReadStream,createWriteStream} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {pipeline} from "node:stream/promises";

const DEFAULT_BUCKET="executive-visuals-media";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashFile=async file=>{
 const hash=createHash("sha256");let bytes=0;
 for await(const chunk of createReadStream(file)){bytes+=chunk.length;hash.update(chunk);}
 return{bytes,sha256:hash.digest("hex")};
};
const run=(command,args)=>{
 const result=spawnSync(command,args,{encoding:"utf8",stdio:"ignore"});
 if(result.error||result.status!==0)throw Object.assign(new Error(command+" could not validate the backup archive."),{code:"STAGING_BACKUP_ARCHIVE_INVALID"});
};

function validObjectPath(value){
 if(typeof value!=="string"||value.length>1024||value.startsWith("/")||value.includes("\\")||value.includes("\0"))return false;
 const parts=value.split("/");
 return parts.length>=3&&parts.length<=12&&UUID.test(parts[0])&&UUID.test(parts[1])&&
  parts.every(part=>part&&part!=="."&&part!==".."&&/^[A-Za-z0-9._-]{1,180}$/.test(part));
}

export async function verifyEncryptedStagingBackup({
 inputFile=process.env.BACKUP_INPUT_FILE,
 passphrase=process.env.STAGING_BACKUP_ENCRYPTION_PASSPHRASE,
 bucket=process.env.STORAGE_BACKUP_BUCKET||DEFAULT_BUCKET,
 runCommand=run
}={}){
 if(!inputFile||!passphrase||String(passphrase).length<24)
  throw Object.assign(new Error("Backup verification requires an encrypted artifact and its independent passphrase."),{code:"STAGING_BACKUP_VERIFY_CONFIG_MISSING"});
 const file=resolve(inputFile);
 const info=await stat(file);
 if(!info.isFile()||info.size<=48)throw Object.assign(new Error("Encrypted staging backup artifact is invalid."),{code:"STAGING_BACKUP_FORMAT_INVALID"});
 const handle=await open(file,"r");
 const header=Buffer.alloc(48);
 try{
  const {bytesRead}=await handle.read(header,0,48,0);
  if(bytesRead!==48||header.subarray(0,4).toString("ascii")!=="EVB1")
   throw Object.assign(new Error("Encrypted staging backup header is invalid."),{code:"STAGING_BACKUP_FORMAT_INVALID"});
 }finally{await handle.close();}

 const work=join(tmpdir(),"executive-visuals-restore-check-"+randomUUID());
 const extracted=join(work,"extracted"),archive=join(work,"backup.tar.gz");
 await mkdir(extracted,{recursive:true});
 try{
  const salt=header.subarray(4,20),nonce=header.subarray(20,32),tag=header.subarray(32,48);
  const key=scryptSync(String(passphrase),salt,32);
  const decipher=createDecipheriv("aes-256-gcm",key,nonce);
  decipher.setAuthTag(tag);
  try{
   await pipeline(createReadStream(file,{start:48}),decipher,createWriteStream(archive,{flags:"wx",mode:0o600}));
  }catch{
   throw Object.assign(new Error("Encrypted staging backup authentication failed; the artifact or passphrase is incorrect."),{code:"STAGING_BACKUP_DECRYPT_FAILED"});
  }
  runCommand("tar",["-xzf",archive,"-C",extracted]);
  const manifestPath=join(extracted,"manifest.json");
  let manifest;
  try{manifest=JSON.parse(await readFile(manifestPath,"utf8"));}catch{
   throw Object.assign(new Error("Backup manifest is missing or invalid."),{code:"STAGING_BACKUP_MANIFEST_INVALID"});
  }
  if(manifest?.format!=="executive-visuals-backup-v1"||manifest.bucket!==bucket||
     !Array.isArray(manifest.objects)||!manifest.database||manifest.database.file!=="database.dump"||
     !Number.isSafeInteger(manifest.database.bytes)||manifest.database.bytes<1||
     !/^[a-f0-9]{64}$/.test(String(manifest.database.sha256||"")))
   throw Object.assign(new Error("Backup manifest does not match the expected format or bucket."),{code:"STAGING_BACKUP_MANIFEST_INVALID"});

  const databaseFile=join(extracted,"database.dump");
  const dbDigest=await hashFile(databaseFile);
  if(dbDigest.bytes!==manifest.database.bytes||dbDigest.sha256!==manifest.database.sha256)
   throw Object.assign(new Error("Database dump checksum or byte count does not match the backup manifest."),{code:"STAGING_BACKUP_DATABASE_CHECKSUM_MISMATCH"});

  const seenNames=new Set(),seenFiles=new Set();
  for(const entry of manifest.objects){
   if(!validObjectPath(entry?.name)||!/^[0-9]{8}\.bin$/.test(String(entry?.file||""))||
      !Number.isSafeInteger(entry.bytes)||entry.bytes<0||!/^[a-f0-9]{64}$/.test(String(entry.sha256||""))||
      seenNames.has(entry.name)||seenFiles.has(entry.file))
    throw Object.assign(new Error("Backup object manifest contains an invalid or duplicate entry."),{code:"STAGING_BACKUP_OBJECT_MANIFEST_INVALID"});
   seenNames.add(entry.name);seenFiles.add(entry.file);
   const objectFile=join(extracted,"objects",entry.file);
   const digest=await hashFile(objectFile);
   if(digest.bytes!==entry.bytes||digest.sha256!==entry.sha256)
    throw Object.assign(new Error("A restored private object failed its manifest checksum."),{code:"STAGING_BACKUP_OBJECT_CHECKSUM_MISMATCH"});
  }
  const objectFiles=(await readdir(join(extracted,"objects"))).filter(name=>name.endsWith(".bin"));
  if(objectFiles.length!==manifest.objects.length)
   throw Object.assign(new Error("Backup contains unlisted or missing private object files."),{code:"STAGING_BACKUP_OBJECT_SET_MISMATCH"});

  runCommand("pg_restore",["--list",databaseFile]);
  return {result:"encrypted_backup_integrity_verified",bucket,storageObjects:manifest.objects.length,
   databaseDumpReadable:true,databaseRestored:false,authenticatedEncryption:true,
   credentialValuesExposed:false};
 }finally{await rm(work,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 verifyEncryptedStagingBackup().then(report=>console.log(JSON.stringify(report))).catch(error=>{
  console.log(JSON.stringify({result:"failed",code:error?.code||"STAGING_BACKUP_VERIFY_FAILED",credentialValuesExposed:false}));
  process.exitCode=1;
 });
}
