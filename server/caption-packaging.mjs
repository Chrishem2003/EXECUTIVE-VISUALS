import { validateSrt, validateWebVtt } from "./caption-validation.mjs";

const MAX_TRACKS=32;
const LANGUAGE_TAG=/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const timestamp=/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/;
function toSeconds(value){
 const m=String(value||"").match(timestamp);
 if(!m)return null;
 return Number(m[1]||0)*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000;
}
function formatTime(seconds,separator){
 const ms=Math.round(seconds*1000),hours=Math.floor(ms/3600000),minutes=Math.floor(ms%3600000/60000),secs=Math.floor(ms%60000/1000),millis=ms%1000;
 return String(hours).padStart(2,"0")+":"+String(minutes).padStart(2,"0")+":"+String(secs).padStart(2,"0")+separator+String(millis).padStart(3,"0");
}
function parseCues(content,format){
 const normalized=String(content??"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n");
 const blocks=normalized.trim().split(/\n\s*\n/).filter(Boolean),cues=[];
 for(const block of blocks){
  const lines=block.split("\n");
  if(format==="webvtt"&&(/^(WEBVTT)(?:\s|$)/.test(lines[0])||/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])))continue;
  const timingIndex=lines.findIndex(line=>line.includes("-->"));
  if(timingIndex<0)continue;
  const match=lines[timingIndex].trim().match(/^([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/);
  if(!match)continue;
  const start=toSeconds(match[1]),end=toSeconds(match[2]);
  if(start===null||end===null||end<=start)continue;
  const text=lines.slice(timingIndex+1).join("\n").trim();
  if(!text)continue;
  cues.push({id:format==="webvtt"&&timingIndex>0?lines[timingIndex-1].trim():String(cues.length+1),start,end,text});
 }
 return cues;
}
function assertFormat(value){
 if(value!=="srt"&&value!=="webvtt")throw Object.assign(new Error("Caption format must be srt or webvtt."),{code:"CAPTION_FORMAT_UNSUPPORTED"});
}
export function convertCaptionFormat(content,{from,to,durationSeconds=null}={}){
 assertFormat(from);assertFormat(to);
 const validation=from==="srt"?validateSrt(content,{durationSeconds}):validateWebVtt(content,{durationSeconds});
 if(validation.status==="blocked")throw Object.assign(new Error("Caption source failed validation and cannot be packaged."),{code:"CAPTION_SOURCE_INVALID",validation});
 const cues=parseCues(content,from);
 if(cues.length!==validation.cueCount)throw Object.assign(new Error("Caption source could not be parsed without losing cues."),{code:"CAPTION_PARSE_MISMATCH",validation});
 const output=to==="webvtt"
  ?"WEBVTT\n\n"+cues.map(cue=>cue.start===null?"":formatTime(cue.start,".")+" --> "+formatTime(cue.end,".")+"\n"+cue.text).join("\n\n")+"\n"
  :cues.map((cue,index)=>(index+1)+"\n"+formatTime(cue.start,",")+" --> "+formatTime(cue.end,",")+"\n"+cue.text).join("\n\n")+"\n";
 const outputValidation=to==="srt"?validateSrt(output,{durationSeconds}):validateWebVtt(output,{durationSeconds});
 if(outputValidation.status==="blocked")throw Object.assign(new Error("Converted caption output failed validation."),{code:"CAPTION_OUTPUT_INVALID",validation:outputValidation});
 return{content:output,format:to,sourceValidation:validation,outputValidation,cueCount:cues.length};
}
export function buildCaptionPackage({tracks=[],defaultFormat="webvtt",durationSeconds=null}={}){
 assertFormat(defaultFormat);
 if(!Array.isArray(tracks)||tracks.length<1||tracks.length>MAX_TRACKS)throw Object.assign(new Error("Caption package must contain between 1 and "+MAX_TRACKS+" tracks."),{code:"CAPTION_TRACK_LIMIT"});
 const seen=new Set(),files=[],reports=[];
 for(const [index,track] of tracks.entries()){
  if(!track||typeof track!=="object"||typeof track.language!=="string"||!LANGUAGE_TAG.test(track.language))throw Object.assign(new Error("Caption track "+(index+1)+" requires a valid BCP 47 language tag."),{code:"CAPTION_LANGUAGE_INVALID"});
  const language=track.language.toLowerCase();
  if(seen.has(language))throw Object.assign(new Error("Caption package contains duplicate language tracks."),{code:"CAPTION_LANGUAGE_DUPLICATE"});
  seen.add(language);
  const from=track.format||(/\.srt$/i.test(String(track.filename||""))?"srt":"webvtt");
  const to=track.outputFormat||defaultFormat;
  const converted=convertCaptionFormat(track.content,{from,to,durationSeconds});
  const filename="captions-"+language+(to==="srt"?".srt":".vtt");
  files.push({filename,mediaType:to==="srt"?"application/x-subrip":"text/vtt",content:converted.content});
  reports.push({language,filename,format:to,cueCount:converted.cueCount,status:converted.outputValidation.status,findings:converted.outputValidation.findings});
 }
 return{schemaVersion:1,manifest:{schema:"executive-visuals.caption-package.v1",generatedAt:new Date().toISOString(),trackCount:files.length,tracks:reports},files};
}
