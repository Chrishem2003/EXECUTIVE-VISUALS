const TERMINAL=new Set(["succeeded","completed","failed","cancelled","canceled"]);
export type CloudRenderJobSnapshot={id:string;status:string};
/** Detect a known render job moving from an active state to a terminal state. */
export function hasCloudRenderJobFinished(previous:readonly CloudRenderJobSnapshot[],next:readonly CloudRenderJobSnapshot[]):boolean{
 const prior=new Map<string,string>();
 for(const job of previous){if(job&&typeof job.id==="string")prior.set(job.id,String(job.status||"").toLowerCase());}
 return next.some(job=>{
  if(!job||typeof job.id!=="string"||!TERMINAL.has(String(job.status||"").toLowerCase()))return false;
  const old=prior.get(job.id);
  return old===undefined||!TERMINAL.has(old);
 });
}
