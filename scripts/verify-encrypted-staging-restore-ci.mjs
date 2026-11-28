import {createCipheriv,createHash,randomBytes,scryptSync,randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyEncryptedStagingBackup} from "./verify-encrypted-staging-backup.mjs";

const passphrase="batch-152-synthetic-restore-test-passphrase";
const owner="123e4567-e89b-42d3-a456-426614174000";
const asset="223e4567-e89b-42d3-a456-426614174000";
const sourceUrl="postgresql://postgres:postgres@localhost:5432/source_test";
const restoreUrl="postgresql://postgres:postgres@localhost:5432/restore_test";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const env={...process.env,PGPASSWORD:"postgres"};

function run(command,args){
 const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:16*1024*1024,env,stdio:["ignore","pipe","pipe"]});
 if(result.error||result.status!==0)throw new Error(command+" failed in synthetic restore rehearsal: "+String(result.stderr||result.error||"").slice(0,500));
 return String(result.stdout||"").trim();
}

async function main(){
 const work=await mkdtemp(join(tmpdir(),"ev-batch152-restore-ci-"+randomUUID()));
 const source=join(work,"source"),objects=join(source,"objects"),artifact=join(work,"synthetic.evb");
 const restoreObjects=join(work,"restored-objects");
 await mkdir(objects,{recursive:true});
 try{
  const dumpVersion=run("pg_dump",["--version"]);
  const restoreVersion=run("pg_restore",["--version"]);
  if(!/\b17\./.test(dumpVersion)||!/\b17\./.test(restoreVersion))
   throw new Error("Synthetic restore must use PostgreSQL 17 clients to match the approved staging database engine.");
  run("createdb",["--host","localhost","--port","5432","--username","postgres","source_test"]);
  const bootstrap=[
   "create extension if not exists pgcrypto;",
   "create schema auth;",
   "create table auth.users(id uuid primary key,email text);",
   "create or replace function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';",
   "create schema executive_visuals;",
   "create table executive_visuals.assets(id uuid primary key,owner_id uuid not null references auth.users(id),name text not null);",
   "create table executive_visuals.project_members(id uuid primary key,user_id uuid not null references auth.users(id),project_id uuid not null);",
   "insert into auth.users(id,email) values('"+owner+"','synthetic@example.test');",
   "insert into executive_visuals.assets(id,owner_id,name) values('"+asset+"','"+owner+"','synthetic asset');",
   "insert into executive_visuals.project_members(id,user_id,project_id) values('323e4567-e89b-42d3-a456-426614174000','"+owner+"','"+asset+"');"
  ].join("\n");
  run("psql",["-X","-v","ON_ERROR_STOP=1","--dbname",sourceUrl,"--command",bootstrap]);

  const dump=join(source,"database.dump");
  run("pg_dump",["--format=custom","--no-owner","--no-acl","--schema=executive_visuals","--file",dump,"--dbname",sourceUrl]);
  const objectPath=owner+"/"+asset+"/preview.bin";
  const objectBytes=Buffer.from("synthetic restored private media bytes");
  const objectFile="00000001.bin";
  await writeFile(join(objects,objectFile),objectBytes,{flag:"wx",mode:0o600});
  const dumpBytes=await readFile(dump);
  const manifest={
   format:"executive-visuals-backup-v1",
   createdAt:"2026-11-28T00:00:00.000Z",
   bucket:"executive-visuals-media",
   database:{file:"database.dump",bytes:dumpBytes.length,sha256:hash(dumpBytes)},
   objects:[{name:objectPath,file:objectFile,bytes:objectBytes.length,sha256:hash(objectBytes)}]
  };
  await writeFile(join(source,"manifest.json"),JSON.stringify(manifest),{flag:"wx",mode:0o600});
  const archive=join(work,"backup.tar.gz");
  run("tar",["-czf",archive,"-C",source,"."]);
  const plain=await readFile(archive),salt=randomBytes(16),nonce=randomBytes(12);
  const cipher=createCipheriv("aes-256-gcm",scryptSync(passphrase,salt,32),nonce);
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  await writeFile(artifact,Buffer.concat([Buffer.from("EVB1"),salt,nonce,cipher.getAuthTag(),encrypted]),{flag:"wx",mode:0o600});

  const result=await verifyEncryptedStagingBackup({
   inputFile:artifact,passphrase,restoreDatabaseUrl:restoreUrl,restoreObjectsDir:restoreObjects
  });
  if(result.result!=="encrypted_backup_full_restore_verified"||result.databaseRestored!==true||result.restoredObjectFiles!==1||result.authUserReferenceColumns!==2)
   throw new Error("Synthetic backup did not complete its full restore contract.");

  const counts=run("psql",["-X","-At","--dbname",restoreUrl,"--command",
   "select (select count(*) from executive_visuals.assets)::text||'|'||(select count(*) from executive_visuals.project_members)::text||'|'||(select count(*) from auth.users where email is null)::text||'|'||(select count(*) from pg_constraint where contype='f' and confrelid='auth.users'::regclass and connamespace='executive_visuals'::regnamespace and convalidated)::text;"
  ]).split("|").map(Number);
  if(counts.length!==4||counts[0]!==1||counts[1]!==1||counts[2]!==1||counts[3]!==2)
   throw new Error("Synthetic restored rows, placeholder identities or validated foreign keys did not match the expected counts.");

  const restored=await readFile(join(restoreObjects,...objectPath.split("/")));
  if(hash(restored)!==hash(objectBytes))throw new Error("Synthetic private object did not survive the local restore.");
  console.log(JSON.stringify({
   result:"synthetic_full_restore_passed",
   databaseRestored:true,
   applicationRows:counts[0]+counts[1],
   authPlaceholderUsers:counts[2],
   validatedAuthForeignKeys:counts[3],
   restoredObjectFiles:result.restoredObjectFiles,
   credentialValuesExposed:false
  }));
 }finally{
  await rm(work,{recursive:true,force:true});
 }
}

main().catch(error=>{
 console.log(JSON.stringify({result:"failed",message:String(error?.message||"restore rehearsal failed").slice(0,300),credentialValuesExposed:false}));
 process.exitCode=1;
});
