import test from "node:test";
import assert from "node:assert/strict";
import {createCipheriv,createHash,randomBytes,scryptSync} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyEncryptedStagingBackup} from "../../scripts/verify-encrypted-staging-backup.mjs";

const passphrase="unit-test-only-backup-passphrase-32";
const owner="123e4567-e89b-42d3-a456-426614174000";
const asset="223e4567-e89b-42d3-a456-426614174000";
const bucket="executive-visuals-media";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");

async function fixture({objectName=owner+"/"+asset+"/original.txt",badObjectHash=false}={}){
 const root=await mkdtemp(join(tmpdir(),"ev-backup-test-"));
 const source=join(root,"source"),objects=join(source,"objects");
 await mkdir(objects,{recursive:true});
 const db=Buffer.from("synthetic PostgreSQL custom-format dump placeholder");
 const object=Buffer.from("synthetic private object bytes");
 await writeFile(join(source,"database.dump"),db);
 await writeFile(join(objects,"00000001.bin"),object);
 const manifest={format:"executive-visuals-backup-v1",createdAt:"2026-11-26T00:00:00.000Z",bucket,
  database:{file:"database.dump",bytes:db.length,sha256:digest(db)},
  objects:[{name:objectName,file:"00000001.bin",bytes:object.length,sha256:badObjectHash?"0".repeat(64):digest(object)}]};
 await writeFile(join(source,"manifest.json"),JSON.stringify(manifest));
 const archive=join(root,"backup.tar.gz");
 const tar=spawnSync("tar",["-czf",archive,"-C",source,"."],{encoding:"utf8"});
 assert.equal(tar.status,0,tar.stderr);
 const plain=await import("node:fs/promises").then(m=>m.readFile(archive));
 const salt=randomBytes(16),nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",scryptSync(passphrase,salt,32),nonce);
 const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
 const file=join(root,"backup.evb");
 await writeFile(file,Buffer.concat([Buffer.from("EVB1"),salt,nonce,cipher.getAuthTag(),encrypted]));
 return{root,file};
}
const command=async(command,args)=>{
 if(command==="tar"){
  const r=spawnSync(command,args,{encoding:"utf8"});if(r.status!==0)throw new Error("tar failed");
 }else if(command==="pg_restore"){
  assert.deepEqual(args.slice(0,1),["--list"]);
 }else throw new Error("unexpected command "+command);
};

test("decrypts and validates database and private-object checksums before pg_restore inspection",async()=>{
 const f=await fixture();
 try{
  const result=await verifyEncryptedStagingBackup({inputFile:f.file,passphrase,runCommand:command});
  assert.equal(result.result,"encrypted_backup_integrity_verified");
  assert.equal(result.storageObjects,1);
  assert.equal(result.databaseDumpReadable,true);
  assert.equal(result.databaseRestored,false);
  assert.equal(result.credentialValuesExposed,false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("rejects a wrong backup passphrase",async()=>{
 const f=await fixture();
 try{await assert.rejects(()=>verifyEncryptedStagingBackup({inputFile:f.file,passphrase:"wrong-passphrase-is-not-the-right-key",runCommand:command}),{code:"STAGING_BACKUP_DECRYPT_FAILED"});}
 finally{await rm(f.root,{recursive:true,force:true});}
});

test("rejects an authenticated archive with a mismatched object checksum",async()=>{
 const f=await fixture({badObjectHash:true});
 try{await assert.rejects(()=>verifyEncryptedStagingBackup({inputFile:f.file,passphrase,runCommand:command}),{code:"STAGING_BACKUP_OBJECT_CHECKSUM_MISMATCH"});}
 finally{await rm(f.root,{recursive:true,force:true});}
});

test("rejects object paths outside the owner and asset namespace",async()=>{
 const f=await fixture({objectName:"../outside/private.txt"});
 try{await assert.rejects(()=>verifyEncryptedStagingBackup({inputFile:f.file,passphrase,runCommand:command}),{code:"STAGING_BACKUP_OBJECT_MANIFEST_INVALID"});}
 finally{await rm(f.root,{recursive:true,force:true});}
});

test("rejects a tampered authenticated backup before extraction",async()=>{
 const f=await fixture();
 try{
  const {readFile,writeFile}=await import("node:fs/promises");
  const data=await readFile(f.file);data[data.length-1]^=1;await writeFile(f.file,data);
  await assert.rejects(()=>verifyEncryptedStagingBackup({inputFile:f.file,passphrase,runCommand:command}),{code:"STAGING_BACKUP_DECRYPT_FAILED"});
 }finally{await rm(f.root,{recursive:true,force:true});}
});
