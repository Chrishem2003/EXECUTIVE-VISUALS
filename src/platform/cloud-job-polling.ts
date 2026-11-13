const TERMINAL_CLOUD_JOB_STATES=new Set(["completed","succeeded","failed","cancelled","canceled"]);

export type CloudJobSnapshot={id:string;status:string};

/** True only when a job moves from a non-terminal state into a terminal state. */
export function hasCloudJobFinished(previous:readonly CloudJobSnapshot[],next:readonly CloudJobSnapshot[]):boolean{
 const prior=new Map(previous.filter(job=>job&&typeof job.id==="string").map(job=>[job.id,String(job.status||"").toLowerCase()]));
 return next.some(job=>{
  if(!job||typeof job.id!=="string"||!TERMINAL_CLOUD_JOB_STATES.has(String(job.status||"").toLowerCase()))return false;
  const oldStatus=prior.get(job.id);
  return oldStatus!==undefined&&!TERMINAL_CLOUD_JOB_STATES.has(oldStatus);
 });
}
