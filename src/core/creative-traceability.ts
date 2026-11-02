import type { EditorialTimeline, TimelineClip } from "./timeline";

export interface CreativeTrace {
  storyBeat: string;
  purpose: string;
  audiencePromise: string;
  proofReference: string;
  decisionNote: string;
}
export interface CreativeTraceFinding {
  code: "TRACE_MISSING" | "BEAT_MISSING" | "PURPOSE_MISSING";
  severity: "review" | "warning";
  clipId: string;
  clipName: string;
  detail: string;
}
export interface CreativeTraceabilityReport {
  totalClips: number;
  linkedClips: number;
  anchoredClips: number;
  coveragePercent: number;
  findings: CreativeTraceFinding[];
  readyForDirectorReview: boolean;
}
const clean=(value:unknown,max:number)=>typeof value==="string"?value.trim().replace(/\s+/g," ").slice(0,max):"";

/** Read only the explicitly authored trace stored with a timeline clip. */
export function readCreativeTrace(clip:TimelineClip):CreativeTrace|null {
  const raw=clip.metadata?.creativeTrace;
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const value=raw as Record<string,unknown>;
  const trace:CreativeTrace={
    storyBeat:clean(value.storyBeat,120),
    purpose:clean(value.purpose,500),
    audiencePromise:clean(value.audiencePromise,300),
    proofReference:clean(value.proofReference,300),
    decisionNote:clean(value.decisionNote,500),
  };
  return Object.values(trace).some(Boolean)?trace:null;
}

/** Missing rationale is visible; the analyzer never invents intent or claims quality. */
export function analyzeCreativeTraceability(timeline:EditorialTimeline|null):CreativeTraceabilityReport {
  const clips=(timeline?.tracks||[]).flatMap(track=>track.clips.filter(clip=>clip.enabled!==false));
  const findings:CreativeTraceFinding[]=[];
  let linkedClips=0,anchoredClips=0;
  for(const clip of clips){
    const trace=readCreativeTrace(clip);
    if(!trace){
      findings.push({code:"TRACE_MISSING",severity:"review",clipId:clip.id,clipName:clip.name,detail:"No creative rationale is recorded for this clip."});
      continue;
    }
    linkedClips++;
    if(trace.storyBeat&&trace.purpose)anchoredClips++;
    if(!trace.storyBeat)findings.push({code:"BEAT_MISSING",severity:"warning",clipId:clip.id,clipName:clip.name,detail:"Choose the story beat this clip is intended to serve."});
    if(!trace.purpose)findings.push({code:"PURPOSE_MISSING",severity:"warning",clipId:clip.id,clipName:clip.name,detail:"Explain what information, emotion or transition this clip contributes."});
  }
  return {
    totalClips:clips.length,linkedClips,anchoredClips,
    coveragePercent:clips.length?Math.round(anchoredClips/clips.length*100):0,
    findings,
    readyForDirectorReview:clips.length>0&&findings.length===0,
  };
}
