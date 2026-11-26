import assert from "node:assert/strict";
import {createDecipheriv,createHash,scryptSync} from "node:crypto";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
const file=resolve(process.argv[2]||"");
const passphrase=process.env.BACKUP_ENCRYPTION_PASSPHRASE||"";
if(!process.argv[2]||!passphrase)throw new Error("Encrypted backup file and passphrase are required.");
const hash=b=>createHash("sha256").update(b).digest("hex");
const temp=await mkdtemp(join(tmpdir(),"ev-backup-verify-"));
try{
 const blob=await readFile(file);
 assert.equal(blob.subarray(0,4).toString(),"EVB1","Unknown encrypted backup format.");
 assert.ok(blob.length>48,"Encrypted backup is truncated.");
 const salt=blob.subarray(4,20),nonce=blob.subarray(20,32),tag=blob.subarray(32,48),ciphertext=blob.subarray(48);
 const key=scryptSync(passphrase,salt,32),decipher=createDecipheriv("aes-256-gcm",key,nonce);
 decipher.setAuthTag(tag);
 const archive=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
 const archivePath=join(temp,"backup.tar.gz");
 await writeFile(archivePath,archive,{mode:0o600});
 const listing=spawnSync("tar",["-tzf",archivePath],{encoding:"utf8",maxBuffer:8*1024*1024});
 if(listing.status!==0)throw new Error("Encrypted archive failed tar integrity validation.");
 for(const entry of listing.stdout.split("\n").filter(Boolean)){
  const normalized=entry.replace(/^\.\//,"").replace(/\/+$/,"");
  if(normalized && (normalized.startsWith("/")||normalized.split("/").some(part=>part===".."||part==="")))throw new Error("Backup archive contains an unsafe path.");
 }
 const extract=spawnSync("tar",["--no-same-owner","--no-same-permissions","-xzf",archivePath,"-C",temp],{encoding:"utf8"});
 if(extract.status!==0)throw new Error("Encrypted archive extraction failed.");
 const source=temp;
 const manifest=JSON.parse(await readFile(join(source,"manifest.json"),"utf8"));
 assert.equal(manifest.format,"executive-visuals-backup-v1");
 assert.equal(manifest.database?.file,"database.dump","Unexpected database dump path.");
 assert.ok(Array.isArray(manifest.objects),"Backup manifest object list is invalid.");
 const db=await readFile(join(source,manifest.database.file));
 assert.equal(db.length,manifest.database.bytes,"Database dump size mismatch.");
 assert.equal(hash(db),manifest.database.sha256,"Database dump SHA-256 mismatch.");
 const pg=spawnSync("pg_restore",["--list",join(source,manifest.database.file)],{encoding:"utf8",maxBuffer:8*1024*1024});
 if(pg.status!==0)throw new Error("pg_restore could not parse the database archive.");
 const seenFiles=new Set();
 for(const item of manifest.objects){
  assert.match(item.file,/^\d{8}\.bin$/,"Unsafe storage object filename in manifest.");
  assert.ok(!seenFiles.has(item.file),"Duplicate storage object filename in manifest.");
  seenFiles.add(item.file);
  const bytes=await readFile(join(source,"objects",item.file));
  assert.equal(bytes.length,item.bytes,"Storage object size mismatch for "+item.file);
  assert.equal(hash(bytes),item.sha256,"Storage object SHA-256 mismatch for "+item.file);
 }
 console.log(JSON.stringify({result:"encrypted_backup_integrity_passed",databaseDumpReadable:true,objectsVerified:manifest.objects.length,archiveBytes:blob.length}));
}finally{await rm(temp,{recursive:true,force:true});}
