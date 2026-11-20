const TERMINAL_CLOUD_JOB_STATES=new Set(["completed","succeeded","failed","cancelled","canceled"]);

export type CloudJobSnapshot={id?:string;jobId?:string;status:string};
export type CloudJobPollingApproval={submitted?:boolean;jobIds?:readonly string[];jobStatuses?:readonly CloudJobSnapshot[]}|null|undefined;
export const CLOUD_JOB_POLL_INTERVAL_MS=5000;

function jobKey(job:CloudJobSnapshot):string{
 return typeof job.id==="string"?job.id:typeof job.jobId==="string"?job.jobId:"";
}

/** True only when a job moves from a non-terminal state into a terminal state. */
export function hasCloudJobFinished(previous:readonly CloudJobSnapshot[],next:readonly CloudJobSnapshot[]):boolean{
 const prior=new Map<string,string>();
 for(const job of previous){const id=job&&jobKey(job);if(id)prior.set(id,String(job.status||"").toLowerCase());}
 return next.some(job=>{
  if(!job)return false;
  const id=jobKey(job),status=String(job.status||"").toLowerCase();
  if(!id||!TERMINAL_CLOUD_JOB_STATES.has(status))return false;
  const oldStatus=prior.get(id);
  return oldStatus!==undefined&&!TERMINAL_CLOUD_JOB_STATES.has(oldStatus);
 });
}

/** Poll only submitted jobs that still have a non-terminal state. */
export function shouldPollCloudJobs(approval:CloudJobPollingApproval,visible=true):boolean{
 if(!visible||approval?.submitted!==true||!Array.isArray(approval.jobIds)||approval.jobIds.length===0)return false;
 const statuses=new Map<string,string>();
 for(const job of approval.jobStatuses||[]){if(!job)continue;const id=jobKey(job);if(id)statuses.set(id,String(job.status||"").toLowerCase());}
 return approval.jobIds.some(id=>typeof id==="string"&&id.length>0&&!TERMINAL_CLOUD_JOB_STATES.has(statuses.get(id)||""));
}

export function isCloudJobTerminal(status:unknown):boolean{
 return typeof status==="string"&&TERMINAL_CLOUD_JOB_STATES.has(status.toLowerCase());
}

/** Select the owner-scoped status endpoint for the queue that accepted the job. */
export function cloudJobStatusPath(backend: string | undefined, jobId: string): string {
 const id=encodeURIComponent(jobId);
 return backend==="neon-postgres"
  ? "/api/neon-staging/video-generation-jobs/"+id
  : "/api/cloud/jobs/"+id;
}
