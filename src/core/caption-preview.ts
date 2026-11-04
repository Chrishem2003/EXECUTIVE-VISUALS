export interface CaptionCue {startSeconds:number;endSeconds:number;text:string}
const timestamp=(value:string):number=>{
 const match=String(value).trim().match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})$/);
 if(!match)return Number.NaN;
 const hours=Number(match[1]||0),minutes=Number(match[2]),seconds=Number(match[3]),millis=Number((match[4]+"00").slice(0,3));
 if(minutes>59||seconds>59)return Number.NaN;
 return hours*3600+minutes*60+seconds+millis/1000;
};
/** Parse bounded SRT or WebVTT text without interpreting markup as HTML. */
export function parseCaptionCues(content:string,maxCues=5000):CaptionCue[]{
 if(typeof content!=="string"||content.length>2*1024*1024)throw new Error("Caption source exceeds the 2 MB preview limit.");
 const normalized=content.replace(/^\uFEFF/,"").replace(/\r/g,"").replace(/^WEBVTT[^\n]*\n/i,"");
 const blocks=normalized.split(/\n\s*\n/),cues:CaptionCue[]=[];
 for(const block of blocks){
  const lines=block.split("\n"),index=lines.findIndex(line=>line.includes("-->"));
  if(index<0)continue;
  const [rawStart,rawEnd]=lines[index].split("-->");
  const startSeconds=timestamp(rawStart.trim().split(/\s+/)[0]),endSeconds=timestamp(rawEnd.trim().split(/\s+/)[0]);
  const text=lines.slice(index+1).join("\n").replace(/<[^>]*>/g,"").replace(/\{[^}]*\}/g,"").trim().slice(0,2000);
  if(!Number.isFinite(startSeconds)||!Number.isFinite(endSeconds)||endSeconds<=startSeconds||!text)continue;
  cues.push({startSeconds,endSeconds,text});
  if(cues.length>maxCues)throw new Error("Caption source exceeds the 5,000 cue preview limit.");
 }
 return cues;
}
export function activeCaptionCues(cues:CaptionCue[],sourceSeconds:number):CaptionCue[]{
 if(!Number.isFinite(sourceSeconds)||sourceSeconds<0)return [];
 return cues.filter(cue=>sourceSeconds>=cue.startSeconds&&sourceSeconds<cue.endSeconds);
}
