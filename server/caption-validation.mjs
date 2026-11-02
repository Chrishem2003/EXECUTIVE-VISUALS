const MAX_CUES=5000;
const MAX_BYTES=2*1024*1024;
function parseTimestamp(value){
 const match=String(value||"").trim().match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/);
 if(!match)return null;
 return Number(match[1]||0)*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;
}
export function validateWebVtt(content,{durationSeconds=null,maxCues=MAX_CUES}={}){
 const text=String(content??""),findings=[];
 const add=(code,severity,detail,cueIndex)=>findings.push({code,severity,detail,...(Number.isInteger(cueIndex)?{cueIndex}:{})});
 if(Buffer.byteLength(text,"utf8")>MAX_BYTES)return{status:"blocked",format:"webvtt",cueCount:0,findings:[{code:"CAPTION_FILE_TOO_LARGE",severity:"error",detail:"Caption file exceeds the 2 MiB limit."}],metrics:{overlaps:0,longLines:0,highReadingSpeed:0}};
 if(!text.startsWith("WEBVTT")||!/^WEBVTT(?:\s|$)/.test(text))return{status:"blocked",format:"webvtt",cueCount:0,findings:[{code:"CAPTION_HEADER_INVALID",severity:"error",detail:"WebVTT must begin with a valid WEBVTT header."}],metrics:{overlaps:0,longLines:0,highReadingSpeed:0}};
 const lines=text.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").split("\n");
 const cues=[];let index=0;
 for(let i=1;i<lines.length;){
  while(i<lines.length&&!lines[i].trim())i++;
  if(i>=lines.length)break;
  if(/^NOTE(?:\s|$)/.test(lines[i])){while(i<lines.length&&lines[i].trim())i++;continue;}
  if(lines[i].startsWith("STYLE")||lines[i].startsWith("REGION")){while(i<lines.length&&lines[i].trim())i++;continue;}
  let timing=lines[i].includes("-->")?lines[i]:null;
  if(!timing&&i+1<lines.length&&lines[i+1].includes("-->")){i++;timing=lines[i];}
  if(!timing){add("CAPTION_CUE_TIMING_INVALID","error","Caption cue "+(index+1)+" has no valid timing line.",index);while(i<lines.length&&lines[i].trim())i++;index++;continue;}
  const match=timing.match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
  const start=match?parseTimestamp(match[1]):null,end=match?parseTimestamp(match[2]):null;
  i++;const body=[];
  while(i<lines.length&&lines[i].trim()){body.push(lines[i]);i++;}
  const cueText=body.join("\n").replace(/<[^>]*>/g,"").trim();
  if(start===null||end===null||end<=start){add("CAPTION_CUE_TIMING_INVALID","error","Caption cue "+(index+1)+" has invalid or non-positive timestamps.",index);}
  else if(!cueText){add("CAPTION_CUE_EMPTY","error","Caption cue "+(index+1)+" contains no readable text.",index);}
  else cues.push({start,end,text:cueText,index});
  index++;
  if(index>Math.min(MAX_CUES,Number(maxCues)||MAX_CUES)){add("CAPTION_CUE_LIMIT_EXCEEDED","error","Caption file exceeds the cue limit.");break;}
 }
 let overlaps=0,longLines=0,highReadingSpeed=0;
 cues.sort((a,b)=>a.start-b.start||a.index-b.index);
 for(let i=0;i<cues.length;i++){
  const cue=cues[i],duration=cue.end-cue.start,characters=cue.text.replace(/\s/g,"").length,cps=characters/duration;
  if(i&&cue.start<cues[i-1].end){overlaps++;add("CAPTION_CUE_OVERLAP","warning","Caption cue "+(cue.index+1)+" overlaps the preceding cue.",cue.index);}
  if(duration>7)add("CAPTION_CUE_TOO_LONG","warning","Caption cue "+(cue.index+1)+" remains on screen for more than 7 seconds.",cue.index);
  if(duration<0.5)add("CAPTION_CUE_TOO_SHORT","warning","Caption cue "+(cue.index+1)+" is visible for less than 0.5 seconds.",cue.index);
  if(cps>20){highReadingSpeed++;add("CAPTION_READING_SPEED_HIGH","warning","Caption cue "+(cue.index+1)+" exceeds 20 non-space characters per second.",cue.index);}
  for(const line of cue.text.split("\n"))if(line.length>42){longLines++;add("CAPTION_LINE_TOO_LONG","warning","Caption cue "+(cue.index+1)+" contains a line longer than 42 characters.",cue.index);}
  if(Number.isFinite(durationSeconds)&&durationSeconds>0&&cue.end>durationSeconds+0.05)add("CAPTION_OUT_OF_RANGE","error","Caption cue "+(cue.index+1)+" ends beyond the media duration.",cue.index);
 }
 if(!cues.length&&!findings.some(item=>item.severity==="error"))add("CAPTION_CUES_MISSING","error","WebVTT contains no readable caption cues.");
 const errors=findings.filter(item=>item.severity==="error").length,warnings=findings.filter(item=>item.severity==="warning").length;
 return{status:errors?"blocked":warnings?"review":"passed",format:"webvtt",cueCount:cues.length,findings,metrics:{overlaps,longLines,highReadingSpeed,durationSeconds:Number.isFinite(durationSeconds)?durationSeconds:null}};
}

export function validateSrt(content,{durationSeconds=null,maxCues=MAX_CUES}={}){
 const text=String(content??"");
 if(Buffer.byteLength(text,"utf8")>MAX_BYTES)return{status:"blocked",format:"srt",cueCount:0,findings:[{code:"CAPTION_FILE_TOO_LARGE",severity:"error",detail:"Caption file exceeds the 2 MiB limit."}],metrics:{overlaps:0,longLines:0,highReadingSpeed:0}};
 const blocks=text.replace(/^\\uFEFF/,"").replace(/\\r\\n?/g,"\\n").trim().split(/\\n\\s*\\n/).filter(Boolean);
 const converted=[];let invalid=0;
 for(const block of blocks){
  const lines=block.split("\\n"),timingIndex=lines.findIndex(line=>line.includes("-->"));
  if(timingIndex<0){invalid++;converted.push("INVALID SRT CUE\\n"+block);continue;}
  const timing=lines[timingIndex].match(/^\\s*(\\d{2,}:[0-5]\\d:[0-5]\\d)[,.](\\d{3})\\s+-->\\s+(\\d{2,}:[0-5]\\d:[0-5]\\d)[,.](\\d{3})(?:\\s+.*)?$/);
  if(!timing){invalid++;converted.push("INVALID SRT CUE\\n"+block);continue;}
  converted.push(timing[1]+"."+timing[2]+" --> "+timing[3]+"."+timing[4]+"\\n"+lines.slice(timingIndex+1).join("\\n"));
 }
 const report=validateWebVtt("WEBVTT\\n\\n"+converted.join("\\n\\n"),{durationSeconds,maxCues});
 const findings=[...report.findings];
 if(invalid)findings.push({code:"CAPTION_SRT_BLOCK_INVALID",severity:"error",detail:invalid+" SRT block(s) have missing or malformed timing lines."});
 const errors=findings.some(item=>item.severity==="error"),warnings=findings.some(item=>item.severity==="warning");
 return{...report,format:"srt",findings,status:errors?"blocked":warnings?"review":"passed"};
}
