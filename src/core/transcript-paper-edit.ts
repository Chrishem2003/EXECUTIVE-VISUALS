import {
 addClip, addTrack, rational, seconds, validateTimeline,
 type EditorialTimeline, type TimelineClip
} from "./timeline.ts";

export interface TranscriptCue { index:number; start:number; end:number; text:string; speaker?:string }
const MAX_BYTES=2*1024*1024;
const MAX_CUES=5000;
function parseTimestamp(value:string):number|null{
 const match=value.trim().match(/^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[,.](\d{3})$/);
 if(!match)return null;
 return Number(match[1]||0)*3600+Number(match[2])*60+Number(match[3])+Number(match[4])/1000;
}
export function parseTranscriptWebVtt(input:string):TranscriptCue[]{
 const text=String(input??"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n");
 if(new TextEncoder().encode(text).byteLength>MAX_BYTES)throw new Error("Transcript exceeds the 2 MiB limit.");
 if(!/^WEBVTT(?:\s|$)/.test(text))throw new Error("Paste a valid WebVTT transcript beginning with WEBVTT.");
 const lines=text.split("\n"),cues:TranscriptCue[]=[];let i=1;
 while(i<lines.length){
  while(i<lines.length&&!lines[i].trim())i++;
  if(i>=lines.length)break;
  if(/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[i])){while(i<lines.length&&lines[i].trim())i++;continue;}
  let timing=lines[i].includes("-->")?lines[i]:null;
  if(!timing&&i+1<lines.length&&lines[i+1].includes("-->")){i++;timing=lines[i];}
  if(!timing)throw new Error("Transcript cue "+(cues.length+1)+" is missing its timing line.");
  const match=timing.match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
  const start=match?parseTimestamp(match[1]):null,end=match?parseTimestamp(match[2]):null;
  i++;const body:string[]=[];
  while(i<lines.length&&lines[i].trim()){body.push(lines[i]);i++;}
  const rawBody=body.join(" ");
  const voice=rawBody.match(/<v(?:\s+([^>]+))?>/i);
  const speaker=voice?.[1]?.trim().replace(/\s+/g," ").slice(0,100);
  const cueText=rawBody.replace(/<v(?:\s+[^>]*)?>/gi,"").replace(/<\/v>/gi,"").replace(/<[^>]*>/g,"").replace(/&nbsp;/gi," ").trim();
  if(cueText.length>1000)throw new Error("Transcript cue "+(cues.length+1)+" exceeds the 1,000-character limit.");
  if(start===null||end===null||end<=start||!cueText)throw new Error("Transcript cue "+(cues.length+1)+" has invalid timing or empty text.");
  cues.push({index:cues.length,start,end,text:cueText,...(speaker?{speaker}:{})});
  if(cues.length>MAX_CUES)throw new Error("Transcript exceeds the 5,000 cue limit.");
 }
 if(!cues.length)throw new Error("Transcript contains no usable cues.");
 return cues.sort((a,b)=>a.start-b.start||a.index-b.index);
}

export function parseTranscriptSrt(input:string):TranscriptCue[]{
 const text=String(input??"").replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n");
 if(new TextEncoder().encode(text).byteLength>MAX_BYTES)throw new Error("Transcript exceeds the 2 MiB limit.");
 const blocks=text.trim().split(/\n\s*\n+/).filter(block=>block.trim());
 const cues:TranscriptCue[]=[];
 for(const block of blocks){
  const lines=block.split("\n");
  const timingIndex=lines.findIndex(line=>line.includes("-->"));
  if(timingIndex<0)throw new Error("SRT cue "+(cues.length+1)+" is missing its timing line.");
  const match=lines[timingIndex].match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
  const start=match?parseTimestamp(match[1]):null,end=match?parseTimestamp(match[2]):null;
  const rawBody=lines.slice(timingIndex+1).join(" ");
  const cueText=rawBody.replace(/<[^>]*>/g,"").replace(/&nbsp;/gi," ").trim();
  if(cueText.length>1000)throw new Error("SRT cue "+(cues.length+1)+" exceeds the 1,000-character limit.");
  if(start===null||end===null||end<=start||!cueText)throw new Error("SRT cue "+(cues.length+1)+" has invalid timing or empty text.");
  cues.push({index:cues.length,start,end,text:cueText});
  if(cues.length>MAX_CUES)throw new Error("Transcript exceeds the 5,000 cue limit.");
 }
 if(!cues.length)throw new Error("Transcript contains no usable SRT cues.");
 return cues.sort((a,b)=>a.start-b.start||a.index-b.index);
}

export function parseTranscriptInput(input:string):TranscriptCue[]{
 const text=String(input??"").replace(/^\uFEFF/,"").trimStart();
 if(/^WEBVTT(?:\s|$)/.test(text))return parseTranscriptWebVtt(text);
 return parseTranscriptSrt(text);
}

export interface TranscriptTextFlag {
 cueIndex:number;
 kind:"filler"|"repetition";
 token:string;
 occurrences:number;
}
const FILLER_WORDS=/\b(?:um+|uh+|erm+|er+|ah+|hmm+)\b/gi;
export function analyzeTranscriptText(cues:TranscriptCue[]):TranscriptTextFlag[]{
 const flags:TranscriptTextFlag[]=[];
 for(const cue of cues){
  const counts=new Map<string,number>();
  for(const match of cue.text.matchAll(FILLER_WORDS)){
   const token=match[0].toLocaleLowerCase();
   counts.set(token,(counts.get(token)||0)+1);
  }
  for(const [token,occurrences] of counts)flags.push({cueIndex:cue.index,kind:"filler",token,occurrences});
  const repeated=/\b([\p{L}']{2,})[\s,]+\1\b/giu;
  for(const match of cue.text.matchAll(repeated)){
   const token=match[1].toLocaleLowerCase();
   flags.push({cueIndex:cue.index,kind:"repetition",token,occurrences:1});
  }
 }
 return flags.sort((a,b)=>a.cueIndex-b.cueIndex||a.kind.localeCompare(b.kind)||a.token.localeCompare(b.token));
}

export interface TranscriptPause { start:number; end:number; duration:number; afterCueIndex:number; beforeCueIndex:number }
export function analyzeTranscriptPauses(cues:TranscriptCue[],minimumDuration=0.75):TranscriptPause[]{
 if(!Number.isFinite(minimumDuration)||minimumDuration<0.1||minimumDuration>30)throw new Error("Pause threshold must be between 0.1 and 30 seconds.");
 const ordered=[...cues].sort((a,b)=>a.start-b.start||a.index-b.index);
 const pauses:TranscriptPause[]=[];
 for(let i=1;i<ordered.length;i++){
  const previous=ordered[i-1],next=ordered[i];
  const duration=next.start-previous.end;
  if(Number.isFinite(duration)&&duration>=minimumDuration){
   pauses.push({start:previous.end,end:next.start,duration,afterCueIndex:previous.index,beforeCueIndex:next.index});
  }
 }
 return pauses;
}

export function createTranscriptPaperEditTrack(timeline:EditorialTimeline,input:{
 sourceTrackId:string;sourceClipId:string;newTrackId:string;clipIdPrefix:string;
 startFrame:number;selectedCueIndices?:number[];cues:TranscriptCue[];
}):EditorialTimeline{
 const sourceTrack=timeline.tracks.find(track=>track.id===input.sourceTrackId);
 if(!sourceTrack||sourceTrack.kind!=="video")throw new Error("Choose a source video track.");
 const sourceClip=sourceTrack.clips.find(clip=>clip.id===input.sourceClipId);
 if(!sourceClip)throw new Error("The selected source clip no longer exists.");
 if(sourceClip.speedCurve?.length)throw new Error("Paper Edit currently requires a constant-speed source clip.");
 const speed=Number(sourceClip.speed??1);
 if(!Number.isFinite(speed)||speed<0.25||speed>4)throw new Error("Source clip playback speed is invalid.");
 const fps=timeline.frameRate.numerator/timeline.frameRate.denominator;
 if(!Number.isFinite(input.startFrame)||!Number.isSafeInteger(input.startFrame)||input.startFrame<0)throw new Error("Paper Edit start frame must be a non-negative integer.");
 if(!input.newTrackId.trim()||!input.clipIdPrefix.trim())throw new Error("Paper Edit requires unique track and clip IDs.");
 if(timeline.tracks.some(track=>track.id===input.newTrackId))throw new Error("Paper Edit track ID already exists.");
 const selected=input.selectedCueIndices?new Set(input.selectedCueIndices):null;
 const cues=input.cues.filter(cue=>!selected||selected.has(cue.index));
 if(!cues.length)throw new Error("Select at least one transcript cue.");
 const sourceStart=seconds(sourceClip.sourceRange.start),sourceEnd=sourceStart+seconds(sourceClip.sourceRange.duration);
 const sourceRate=sourceClip.sourceRange.start.rate;
 let next=addTrack(timeline,{id:input.newTrackId,name:"Paper Edit",kind:"video",enabled:true,locked:false,clips:[]});
 let cursor=input.startFrame;
 let inserted=0;
 for(const cue of cues){
  if(!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.start<sourceStart-0.001||cue.end>sourceEnd+0.001||cue.end<=cue.start||!cue.text.trim())
   throw new Error("Transcript cue "+(cue.index+1)+" falls outside the selected source clip.");
  const sourceIn=Math.max(sourceStart,Math.round(cue.start*sourceRate)/sourceRate);
  const durationFrames=Math.floor(((cue.end-sourceIn)/speed)*fps+1e-8);
  if(durationFrames<1)continue;
  const timelineDuration=durationFrames/fps;
  const sourceDuration=timelineDuration*speed;
  const clip:TimelineClip={
   id:input.clipIdPrefix+"-"+cue.index,assetId:sourceClip.assetId,
   name:sourceClip.name+" · "+cue.text.slice(0,52),
   sourceRange:{start:rational(sourceIn*sourceRate,sourceRate),duration:rational(sourceDuration*sourceRate,sourceRate)},
   timelineStart:rational(cursor,fps),duration:rational(durationFrames,fps),
   enabled:true,speed,
   metadata:{paperEdit:true,sourceClipId:sourceClip.id,transcriptCueIndex:cue.index,transcriptText:cue.text}
  };
  next=addClip(next,input.newTrackId,clip);
  cursor+=durationFrames;inserted++;
 }
 if(!inserted)throw new Error("No transcript cues were long enough to create a timeline clip.");
 const validation=validateTimeline(next);
 if(!validation.valid)throw new Error(validation.issues[0].message);
 return next;
}
