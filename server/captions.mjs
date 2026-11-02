import { validateWebVtt } from "./caption-validation.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, relative, sep, resolve } from "node:path";
import { json } from "./db.mjs";

const MAX_CAPTIONS=5000;
const MAX_TEXT=1000;
const cleanText=value=>String(value??"").replace(/\r/g," ").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,"").replace(/<[^>]*>/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").trim().slice(0,MAX_TEXT);
function timestamp(value){
 const ms=Math.round(value*1000);
 const hours=Math.floor(ms/3600000),minutes=Math.floor(ms%3600000/60000),seconds=Math.floor(ms%60000/1000),millis=ms%1000;
 return [String(hours).padStart(2,"0"),String(minutes).padStart(2,"0"),String(seconds).padStart(2,"0")+"."+String(millis).padStart(3,"0")].join(":");
}
export function buildWebVtt(segments,{offsetSeconds=0,maxCues=MAX_CAPTIONS}={}){
 if(!Array.isArray(segments)||segments.length===0)throw Object.assign(new Error("Caption generation requires timestamped transcript segments."),{code:"CAPTION_SEGMENTS_REQUIRED"});
 if(segments.length>Math.min(MAX_CAPTIONS,Number(maxCues)||MAX_CAPTIONS))throw Object.assign(new Error("Transcript exceeds the 5,000 caption cue limit."),{code:"CAPTION_LIMIT_EXCEEDED"});
 const offset=Number(offsetSeconds);
 if(!Number.isFinite(offset)||Math.abs(offset)>86400)throw Object.assign(new Error("Caption offset is outside the supported range."),{code:"CAPTION_INVALID_OFFSET"});
 const cues=segments.map((segment,index)=>{
  const start=Number(segment?.start)+offset,end=Number(segment?.end)+offset,text=cleanText(segment?.text);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>7*24*3600||!text)throw Object.assign(new Error("Transcript contains an invalid caption cue at index "+index+"."),{code:"CAPTION_INVALID_SEGMENT"});
  return {start,end,text,index};
 }).sort((a,b)=>a.start-b.start||a.end-b.end||a.index-b.index);
 for(let i=1;i<cues.length;i++)if(cues[i].start<cues[i-1].start)throw Object.assign(new Error("Caption cues are not ordered."),{code:"CAPTION_INVALID_SEGMENT"});
 return "WEBVTT\n\n"+cues.map(cue=>timestamp(cue.start)+" --> "+timestamp(cue.end)+"\n"+cue.text).join("\n\n")+"\n";
}
const safeSegment=value=>String(value||"").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,80)||"unknown";
export async function storeCaptionAsset({db,mediaRoot,ownerId,projectId=null,jobId,sourceAssetId,language="",segments,content}){
 const text=String(content??buildWebVtt(segments));
 const buffer=Buffer.from(text,"utf8");
 if(!text.startsWith("WEBVTT\n")||buffer.length>2*1024*1024)throw Object.assign(new Error("Generated WebVTT is invalid or exceeds the 2 MiB limit."),{code:"CAPTION_ASSET_INVALID"});
 const durationSeconds=Array.isArray(segments)?Math.max(0,...segments.map(segment=>Number(segment?.end)||0)):null;
 const captionValidation=validateWebVtt(text,{durationSeconds});
 if(captionValidation.status==="blocked")throw Object.assign(new Error("Generated WebVTT failed caption validation."),{code:"CAPTION_VALIDATION_FAILED",validation:captionValidation});
 const id=randomUUID(),directory=join(mediaRoot,safeSegment(ownerId),safeSegment(projectId||"personal"));
 const root=resolve(mediaRoot),absolute=resolve(directory,id+".vtt"),storagePath=relative(root,absolute).split(sep).join("/");
 if(storagePath.startsWith("..")||resolve(root,storagePath)!==absolute)throw Object.assign(new Error("Caption asset path failed validation."),{code:"ASSET_PATH_INVALID"});
 await mkdir(directory,{recursive:true});
 try{
  await writeFile(absolute,buffer,{flag:"wx"});
  const sha256=createHash("sha256").update(buffer).digest("hex");
  const metadata={generated:true,kind:"webvtt-captions",sourceAssetId:String(sourceAssetId||""),language:String(language||"").slice(0,32),segmentCount:Array.isArray(segments)?segments.length:0,durationSeconds:durationSeconds||0,captionValidation,jobId,createdAt:new Date().toISOString()};
  const name="captions-"+id+".vtt";
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
   .run(id,ownerId,projectId,name,"text/vtt",buffer.length,sha256,storagePath,json(metadata));
  return {id,projectId,name,mediaType:"text/vtt",size:buffer.length,sha256,storagePath,metadata};
 }catch(error){await unlink(absolute).catch(()=>{});throw error;}
}

export function applyTranslatedSegments(sourceSegments,translatedPayload){
 if(!Array.isArray(sourceSegments)||sourceSegments.length===0||sourceSegments.length>500)throw Object.assign(new Error("Translation requires between 1 and 500 timed caption segments."),{code:"TRANSLATION_SEGMENTS_INVALID"});
 const translated=Array.isArray(translatedPayload)?translatedPayload:translatedPayload?.segments;
 if(!Array.isArray(translated)||translated.length!==sourceSegments.length)throw Object.assign(new Error("Translation response must contain exactly one result for every source cue."),{code:"TRANSLATION_RESPONSE_INVALID"});
 return sourceSegments.map((source,index)=>{
  const item=translated[index];
  if(Number(item?.index)!==index||typeof item?.text!=="string")throw Object.assign(new Error("Translation response cue order or shape is invalid."),{code:"TRANSLATION_RESPONSE_INVALID"});
  const text=cleanText(item.text);
  if(!text||text.length>MAX_TEXT)throw Object.assign(new Error("Translated caption text is empty or too long."),{code:"TRANSLATION_RESPONSE_INVALID"});
  return {start:Number(source.start),end:Number(source.end),text};
 });
}
