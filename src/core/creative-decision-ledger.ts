import type { CreativeTrace } from "./creative-traceability";
import type { TimelineClip } from "./timeline";

export interface CreativeDecisionRecord {
  id: string;
  sequence: number;
  recordedAt: string;
  summary: string;
  before: CreativeTrace | null;
  after: CreativeTrace | null;
}
const FIELDS: Array<{key:keyof CreativeTrace;label:string}> = [
  {key:"storyBeat",label:"story beat"},
  {key:"purpose",label:"shot purpose"},
  {key:"audiencePromise",label:"audience promise"},
  {key:"proofReference",label:"proof reference"},
  {key:"decisionNote",label:"decision note"},
];
const clean=(value:unknown,max:number)=>typeof value==="string"?value.trim().replace(/\s+/g," ").slice(0,max):"";
function normalize(value:unknown):CreativeTrace|null{
 if(!value||typeof value!=="object"||Array.isArray(value))return null;
 const raw=value as Record<string,unknown>;
 const trace:CreativeTrace={
  storyBeat:clean(raw.storyBeat,120),purpose:clean(raw.purpose,500),
  audiencePromise:clean(raw.audiencePromise,300),proofReference:clean(raw.proofReference,300),
  decisionNote:clean(raw.decisionNote,500),
 };
 return Object.values(trace).some(Boolean)?trace:null;
}
function equal(a:CreativeTrace|null,b:CreativeTrace|null){return FIELDS.every(field=>(a?.[field.key]||"")===(b?.[field.key]||""));}
function summary(before:CreativeTrace|null,after:CreativeTrace|null){
 const changed=FIELDS.filter(field=>(before?.[field.key]||"")!==(after?.[field.key]||""));
 return changed.length?"Updated "+changed.map(field=>field.label).join(", "):"No creative intent change";
}
export function readCreativeDecisionHistory(clip:TimelineClip):CreativeDecisionRecord[]{
 const raw=clip.metadata?.creativeTraceHistory;
 if(!Array.isArray(raw))return [];
 return raw.slice(-100).flatMap((item):CreativeDecisionRecord[]=>{
  if(!item||typeof item!=="object"||Array.isArray(item))return [];
  const value=item as Record<string,unknown>;
  const id=clean(value.id,120),recordedAt=clean(value.recordedAt,40),sequence=Number(value.sequence);
  if(!id||!Number.isInteger(sequence)||sequence<1||!Number.isFinite(Date.parse(recordedAt)))return [];
  return [{
   id,sequence,recordedAt,summary:clean(value.summary,300)||"Creative decision recorded",
   before:normalize(value.before),after:normalize(value.after),
  }];
 });
}
/** Append-only by contract: existing entries are copied, never edited; history is bounded to 100 entries. */
export function appendCreativeDecision(
 history:CreativeDecisionRecord[],beforeInput:CreativeTrace|null,afterInput:CreativeTrace|null,id:string,recordedAt:string
):CreativeDecisionRecord[]{
 const before=normalize(beforeInput),after=normalize(afterInput);
 if(equal(before,after))return history.slice(-100);
 const safeId=clean(id,120),safeDate=clean(recordedAt,40);
 if(!safeId||!Number.isFinite(Date.parse(safeDate)))throw new Error("A valid decision ID and timestamp are required.");
 if(history.some(record=>record.id===safeId))throw new Error("Creative decision IDs must be unique.");
 const sequence=(history.at(-1)?.sequence||0)+1;
 const record:CreativeDecisionRecord={id:safeId,sequence,recordedAt:new Date(safeDate).toISOString(),summary:summary(before,after),before,after};
 return [...history,record].slice(-100);
}
