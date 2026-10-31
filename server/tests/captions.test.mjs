import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../db.mjs";
import { buildWebVtt, storeCaptionAsset, applyTranslatedSegments } from "../captions.mjs";

const root=await mkdtemp(join(tmpdir(),"executive-visuals-captions-"));
const mediaRoot=join(root,"media");
const db=openDatabase(join(root,"runtime.sqlite"));
try{
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("caption-user","captions@example.test");
 const segments=[
  {start:1.25,end:2.4,text:"  Hello <script>alert(1)</script> & welcome  "},
  {start:0,end:1.1,text:"Opening line"}
 ];
 const vtt=buildWebVtt(segments);
 assert.ok(vtt.startsWith("WEBVTT\n\n"));
 assert.ok(vtt.includes("00:00:00.000 --> 00:00:01.100\nOpening line"));
 assert.ok(vtt.includes("00:00:01.250 --> 00:00:02.400\nHello alert(1) &amp; welcome"));
 assert.ok(!vtt.includes("<script>"));
 assert.throws(()=>buildWebVtt([{start:2,end:1,text:"bad"}]),/invalid caption cue/i);
 assert.throws(()=>buildWebVtt([]),/timestamped transcript segments/i);
 const translated=applyTranslatedSegments(segments.map(item=>({start:item.start,end:item.end,text:item.text})),[{index:0,text:"Ligne d'ouverture"},{index:1,text:"Bonjour & bienvenue"}]);
 assert.equal(translated[0].start,1.25);
 assert.equal(translated[0].end,2.4);
 assert.equal(translated[0].text,"Ligne d'ouverture");
 assert.throws(()=>applyTranslatedSegments(segments,[{index:1,text:"wrong order"},{index:0,text:"wrong order"}]),/order or shape/i);
 const asset=await storeCaptionAsset({db,mediaRoot,ownerId:"caption-user",jobId:"caption-job",sourceAssetId:"audio-source",language:"en",segments,content:vtt});
 assert.equal(asset.mediaType,"text/vtt");
 assert.equal(asset.metadata.segmentCount,2);
 assert.equal(asset.metadata.durationSeconds,2.4);
 const row=db.prepare("SELECT * FROM assets WHERE id=?").get(asset.id);
 assert.equal(row.media_type,"text/vtt");
 assert.equal(row.sha256,asset.sha256);
 assert.equal(await readFile(resolve(mediaRoot,row.storage_path),"utf8"),vtt);
 console.log("Caption asset checks passed: timestamp ordering, cue validation, markup sanitization, private text/vtt persistence and SHA-256 lineage.");
}finally{db.close();await rm(root,{recursive:true,force:true});}
