import {createDecipheriv,createHash,scryptSync,randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {copyFile,mkdir,open,readdir,rm,stat,readFile} from "node:fs/promises";
import {constants as fsConstants,createReadStream} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve,sep} from "node:path";
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
 const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:16*1024*1024,stdio:"ignore"});
 if(result.error||result.status!==0)throw Object.assign(new Error(command+" could not validate or restore the backup archive."),{code:"STAGING_BACKUP_ARCHIVE_INVALID"});
};

function validObjectPath(value){
 if(typeof value!=="string"||value.length>1024||value.startsWith("/")||value.includes("\\\\")||value.includes("\\0"))return false;
 const parts=value.split("/");
 return parts.length>=3&&parts.length<=12&&UUID.test(parts[0])&&UUID.test(parts[1])&&
  parts.every(part=>part&&part!=="."&&part!==".."&&/^[A-Za-z0-9._-]{1,180}$/.test(part));
}

function validateRestoreTarget(value){
 let url;
 try{url=new URL(value);}catch{throw Object.assign(new Error("Restore rehearsal requires a valid local PostgreSQL URL."),{code:"STAGING_BACKUP_RESTORE_TARGET_INVALID"});}
 const host=url.hostname.toLowerCase();
 const database=url.pathname.replace(/^\\//,"");
 if(!["postgres:","postgresql:"].includes(url.protocol)||!["localhost","127.0.0.1","::1"].includes(host)||
    database!=="restore_test"||url.search||url.hash)
  throw Object.assign(new Error("Backup restore is restricted to the disposable local restore_test database."),{code:"STAGING_BACKUP_RESTORE_TARGET_INVALID"});
 return url.toString();
}

function quoteIdentifier(value){
 if(typeof value!=="string"||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
  throw Object.assign(new Error("Backup schema contains an unsupported identifier."),{code:"STAGING_BACKUP_RESTORE_SCHEMA_INVALID"});
 return '"'+value+'"';
}

export function parseAuthUserForeignKeys(schemaSql){
 if(typeof schemaSql!=="string")throw Object.assign(new Error("Backup schema SQL is missing."),{code:"STAGING_BACKUP_RESTORE_SCHEMA_INVALID"});
 const pattern=/ALTER TABLE ONLY\\s+"?executive_visuals"?\\."?([A-Za-z_][A-Za-z0-9_]*)"?\\s+ADD CONSTRAINT\\s+"?[A-Za-z_][A-Za-z0-9_]*"?\\s+FOREIGN KEY\\s*\\(([^)]+)\\)\\s+REFERENCES\\s+"?auth"?\\."?users"?\\s*\\(\\s*"?id"?\\s*\\)/gim;
 const found=new Map();
 for(const match of schemaSql.matchAll(pattern)){
  const table=match[1];
  const columns=match[2].split(",").map(value=>value.trim().replace(/^"|"$/g,""));
  if(columns.length!==1)throw Object.assign(new Error("Composite auth.users foreign keys require a reviewed restore adapter."),{code:"STAGING_BACKUP_RESTORE_SCHEMA_UNSUPPORTED"});
  const column=columns[0];
  quoteIdentifier(table);quoteIdentifier(column);
  found.set(table+"."+column,{table,column});
 }
 if(!found.size)throw Object.assign(new Error("The database dump has no discoverable executive_visuals foreign keys to auth.users."),{code:"STAGING_BACKUP_AUTH_FK_MANIFEST_MISSING"});
 return [...found.values()];
}

async function restoreDatabaseAndObjects({databaseFile,extracted,manifest,restoreDatabaseUrl,restoreObjectsDir,runCommand}){
 const target=validateRestoreTarget(restoreDatabaseUrl);
 const schemaFile=join(dirname(databaseFile),"database-schema.sql");
 runCommand("pg_restore",["--schema-only","--no-owner","--no-acl","--file",schemaFile,databaseFile]);
 const schemaSql=await readFile(schemaFile,"utf8");
 const references=parseAuthUserForeignKeys(schemaSql);

 const bootstrapSql=`
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users(
 id uuid primary key,
 email text,
 role text,
 raw_app_meta_data jsonb not null default '{}'::jsonb,
 raw_user_meta_data jsonb not null default '{}'::jsonb,
 created_at timestamptz,
 updated_at timestamptz
);
create or replace function auth.uid()
returns uuid language sql stable
as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
`;
 runCommand("psql",["-X","-v","ON_ERROR_STOP=1","--dbname",target,"--command",bootstrapSql]);
 for(const section of ["pre-data","data"]){
  runCommand("pg_restore",["--no-owner","--no-acl","--exit-on-error","--section="+section,"--dbname",target,databaseFile]);
 }
 const placeholderSql=references.map(({table,column})=>
  "insert into auth.users (id) select distinct "+quoteIdentifier(column)+
  " from executive_visuals."+quoteIdentifier(table)+" where "+quoteIdentifier(column)+
  " is not null on conflict (id) do nothing;"
 ).join("\\n");
 runCommand("psql",["-X","-v","ON_ERROR_STOP=1","--dbname",target,"--command",placeholderSql]);
 runCommand("pg_restore",["--no-owner","--no-acl","--exit-on-error","--section=post-data","--dbname",target,databaseFile]);
 const verifySql=`
do $restore_verify$
declare v_tables integer; v_foreign_keys integer; v_unvalidated integer;
begin
 select count(*)::integer into v_tables from information_schema.tables
  where table_schema='executive_visuals' and table_type='BASE TABLE';
 select count(*)::integer into v_foreign_keys from pg_constraint
  where contype='f' and confrelid='auth.users'::regclass
    and connamespace='executive_visuals'::regnamespace;
 select count(*)::integer into v_unvalidated from pg_constraint
  where contype='f' and connamespace='executive_visuals'::regnamespace and not convalidated;
 if v_tables<1 then raise exception 'Restore rehearsal did not restore application tables'; end if;
 if v_foreign_keys<1 then raise exception 'Restore rehearsal did not restore auth identity relationships'; end if;
 if v_unvalidated>0 then raise exception 'Restore rehearsal left unvalidated foreign keys: %',v_unvalidated; end if;
end;
$restore_verify$;
`;
 runCommand("psql",["-X","-v","ON_ERROR_STOP=1","--dbname",target,"--command",verifySql]);

 const root=resolve(restoreObjectsDir);
 await mkdir(root,{recursive:true});
 for(const entry of manifest.objects){
  const segments=entry.name.split("/");
  const destination=resolve(root,...segments);
  if(destination===root||!destination.startsWith(root+sep))
   throw Object.assign(new Error("Restored object path escaped the local restore directory."),{code:"STAGING_BACKUP_RESTORE_OBJECT_PATH_INVALID"});
  await mkdir(dirname(destination),{recursive:true});
  await copyFile(join(extracted,"objects",entry.file),destination,fsConstants.COPYFILE_EXCL);
  const digest=await hashFile(destination);
  if(digest.bytes!==entry.bytes||digest.sha256!==entry.sha256)
   throw Object.assign(new Error("A restored object failed its post-copy checksum."),{code:"STAGING_BACKUP_RESTORE_OBJECT_CHECKSUM_MISMATCH"});
 }
 return {databaseRestored:true,restoredObjectFiles:manifest.objects.length,authUserReferenceColumns:references.length};
}

export async function verifyEncryptedStagingBackup({
 inputFile=process.env.BACKUP_INPUT_FILE,
 passphrase=process.env.STAGING_BACKUP_ENCRYPTION_PASSPHRASE,
 bucket=process.env.STORAGE_BACKUP_BUCKET||DEFAULT_BUCKET,
 restoreDatabaseUrl=process.env.RESTORE_DATABASE_URL,
 restoreObjectsDir=process.env.RESTORE_OBJECTS_DIR,
 runCommand=run
}={}){
 if(!inputFile||!passphrase||String(passphrase).length<24)
  throw Object.assign(new Error("Backup verification requires an encrypted artifact and its independent passphrase."),{code:"STAGING_BACKUP_VERIFY_CONFIG_MISSING"});
 if(Boolean(restoreDatabaseUrl)!==Boolean(restoreObjectsDir))
  throw Object.assign(new Error("Full restore requires both a disposable local database URL and a local object restore directory."),{code:"STAGING_BACKUP_RESTORE_CONFIG_INCOMPLETE"});
 if(restoreDatabaseUrl)validateRestoreTarget(restoreDatabaseUrl);
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
   if(!validObjectPath(entry?.name)||!/^[0-9]{8}\\.bin$/.test(String(entry?.file||""))||
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
  const restore=restoreDatabaseUrl
   ?await restoreDatabaseAndObjects({databaseFile,extracted,manifest,restoreDatabaseUrl,restoreObjectsDir,runCommand})
   :{databaseRestored:false,restoredObjectFiles:0,authUserReferenceColumns:0};
  return {result:restore.databaseRestored?"encrypted_backup_full_restore_verified":"encrypted_backup_integrity_verified",
   bucket,storageObjects:manifest.objects.length,databaseDumpReadable:true,databaseRestored:restore.databaseRestored,
   restoredObjectFiles:restore.restoredObjectFiles,authUserReferenceColumns:restore.authUserReferenceColumns,
   authenticatedEncryption:true,credentialValuesExposed:false};
 }finally{await rm(work,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 verifyEncryptedStagingBackup().then(report=>console.log(JSON.stringify(report))).catch(error=>{
  console.log(JSON.stringify({result:"failed",code:error?.code||"STAGING_BACKUP_VERIFY_FAILED",credentialValuesExposed:false}));
  process.exitCode=1;
 });
}
