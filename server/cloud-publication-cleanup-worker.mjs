import { randomUUID } from "node:crypto";
import { createCloudStorage } from "./cloud-storage.mjs";
import { createCloudPublicationCleanup } from "./cloud-publication-cleanup.mjs";
import { createCloudPublicationAuditSink,createCloudPublicationAuditHandler } from "./cloud-publication-audit.mjs";

const TERMINAL_CLEANUP_STATES=new Set(["failed","cancelled","expired"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS=24*60*60*1000;

function safeOrigin(value){
 let parsed;
 try{parsed=new URL(value);}catch{throw new Error("Publication cleanup worker requires a valid Supabase URL.");}
 const local=["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname.toLowerCase());
 if((parsed.protocol!=="https:"&&!(local&&parsed.protocol==="http:"))||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error("Publication cleanup worker requires a safe HTTPS Supabase URL.");
 return parsed.origin;
}
function safePublication(row){
 if(!row||!UUID.test(row.owner_id||"")||!UUID.test(row.asset_id||"")||!UUID.test(row.job_id||"")||
    row.project_id!==null&&!UUID.test(row.project_id||"")||
    typeof row.publication_key!=="string"||row.publication_key.length<1||row.publication_key.length>200||
    !["reserved","published"].includes(row.status)||!Number.isFinite(Date.parse(row.updated_at||"")))return null;
 return row;
}

/**
 * Bounded, opt-in publication cleanup worker.
 * Defaults to dry-run. Destructive execution additionally requires an explicit
 * two-flag operator gate; the database claim RPC remains the final authority.
 */
export function createCloudPublicationCleanupWorker({
 url=process.env.SUPABASE_URL,
 serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
 fetchImpl=globalThis.fetch,
 storage,
 olderThanMs=DAY_MS,
 publicationLimit=10,
 objectLimit=100,
 pollIntervalMs=300000,
 dryRun=true,
 confirmDelete=false,
 allowDelete=false,
 now=()=>new Date(),
 onLog=()=>{}
}={}){
 if(!url||!serviceRoleKey)throw new Error("Publication cleanup worker requires server-side Supabase credentials.");
 if(typeof fetchImpl!=="function")throw new Error("Publication cleanup worker requires fetch.");
 if(!Number.isSafeInteger(olderThanMs)||olderThanMs<DAY_MS||olderThanMs>30*DAY_MS)throw new Error("Publication cleanup worker age must be between 1 and 30 days.");
 if(!Number.isInteger(publicationLimit)||publicationLimit<1||publicationLimit>50)throw new Error("Publication cleanup worker publication limit must be between 1 and 50.");
 if(!Number.isInteger(objectLimit)||objectLimit<1||objectLimit>100)throw new Error("Publication cleanup worker object limit must be between 1 and 100.");
 if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<10000||pollIntervalMs>3600000)throw new Error("Publication cleanup worker poll interval must be between 10 seconds and 1 hour.");
 if(typeof dryRun!=="boolean"||typeof confirmDelete!=="boolean"||typeof allowDelete!=="boolean")throw new Error("Publication cleanup worker safety gates must be boolean.");
 if(!dryRun&&(!confirmDelete||!allowDelete))throw new Error("Destructive publication cleanup requires both explicit confirmation and the worker delete enable flag.");
 if(typeof onLog!=="function")throw new Error("Publication cleanup worker logger must be a function.");
 const base=safeOrigin(url);
 const cloudStorage=storage||createCloudStorage({url,serviceRoleKey,fetchImpl});
 async function request(path,{method="GET",body=null,prefer=null}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json"};
   if(body!==null)headers["content-type"]="application/json";
   if(prefer)headers.prefer=prefer;
   const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   const raw=await response.text();
   let data=null;
   if(raw){try{data=JSON.parse(raw);}catch{if(response.ok)throw new Error("Publication cleanup database returned invalid JSON.");}}
   if(!response.ok){const error=new Error("Publication cleanup database request failed (HTTP "+response.status+").");error.code="PUBLICATION_CLEANUP_HTTP_"+response.status;throw error;}
   return data;
  }catch(error){if(error?.name==="AbortError")throw new Error("Publication cleanup database request timed out.");throw error;}
  finally{clearTimeout(timer);}
 }
 async function rpc(name,args){
  const rows=await request("rpc/"+name,{method:"POST",body:args});
  return rows;
 }
 let publicationOffset=0,pendingClaimOffset=0;
 const publicationCursors=new Map();
 async function listStalePublications(offset=0){
  const cutoff=new Date(now().getTime()-olderThanMs).toISOString();
  const params=new URLSearchParams({
   select:"owner_id,project_id,job_id,publication_key,asset_id,status,updated_at",
   status:"in.(reserved,published)",
   updated_at:"lte."+cutoff,
   order:"updated_at.asc,owner_id.asc,publication_key.asc",
   limit:String(publicationLimit),
   offset:String(offset)
  });
  const rows=await request("asset_publications?"+params.toString());
  if(!Array.isArray(rows))throw new Error("Publication cleanup ledger returned an invalid list.");
  return rows.map(safePublication).filter(Boolean);
 }
 async function getJob(jobId){
  const params=new URLSearchParams({select:"id,status,lease_expires_at",id:"eq."+jobId,limit:"1"});
  const rows=await request("jobs?"+params.toString());
  return Array.isArray(rows)&&rows.length===1?rows[0]:null;
 }
 function createAuditFor(publication,runId){
  const sink=createCloudPublicationAuditSink({
   url,serviceRoleKey,ownerId:publication.owner_id,projectId:publication.project_id,
   jobId:publication.job_id,publicationKey:publication.publication_key,actorType:"system",runId,fetchImpl
  });
  return createCloudPublicationAuditHandler({sink,maxAttempts:3,retryDelayMs:250,onRetry:event=>onLog({kind:"audit_retry",...event})});
 }
 async function createCleanupFor(publication,runId){
  const scopeId=publication.project_id||publication.owner_id;
  const prefix=scopeId+"/"+publication.asset_id+"/";
  const audit=createAuditFor(publication,runId);
  return createCloudPublicationCleanup({
   storage:cloudStorage,
   requireAudit:true,
   onEvent:event=>audit.onEvent(event),
   findReferencedPaths:async paths=>{
    if(!paths.length)return [];
    const params=new URLSearchParams({select:"object_path",object_path:"in.("+paths.map(path=>'"'+path+'"').join(",")+")"});
    const rows=await request("assets?"+params.toString());
    if(!Array.isArray(rows))throw new Error("Publication cleanup asset-reference query returned an invalid response.");
    return rows.map(row=>row.object_path);
   },
   isAttemptActive:async()=>{
    const job=await getJob(publication.job_id);
    if(!job)return null;
    if(!TERMINAL_CLEANUP_STATES.has(job.status))return true;
    if(job.lease_expires_at&&Date.parse(job.lease_expires_at)>now().getTime())return true;
    return false;
   },
   claimCleanup:async input=>{
    const rows=await rpc("claim_asset_publication_cleanup_v1",{
     p_job_id:publication.job_id,p_owner_id:publication.owner_id,p_project_id:publication.project_id,
     p_publication_key:publication.publication_key,p_object_path:input.objectPath,
     p_min_age:Math.floor(olderThanMs/3600000)+" hours"
    });
    if(!Array.isArray(rows)||rows.length!==1)return null;
    const row=rows[0];
    return {claimId:row.claim_id,claimToken:row.claim_token,status:row.status};
   },
   completeCleanup:async claim=>{
    const result=await rpc("complete_asset_publication_cleanup_v1",{p_claim_id:claim.claimId,p_claim_token:claim.claimToken});
    return result===true;
   },
   now
  });
 }
 async function listPendingClaims(offset=0){
  const params=new URLSearchParams({
   select:"id,claim_token,object_path,job_id,owner_id,project_id,publication_id,claimed_at",
   status:"eq.claimed",
   order:"claimed_at.asc,id.asc",
   limit:String(objectLimit),
   offset:String(offset)
  });
  const rows=await request("asset_publication_cleanup_claims?"+params.toString());
  if(!Array.isArray(rows))throw new Error("Pending publication cleanup claims returned an invalid list.");
  return rows;
 }
 async function getPublicationById(publicationId){
  const params=new URLSearchParams({
   select:"owner_id,project_id,job_id,publication_key,asset_id,status,updated_at",
   id:"eq."+publicationId,
   limit:"1"
  });
  const rows=await request("asset_publications?"+params.toString());
  if(!Array.isArray(rows)||rows.length!==1)return null;
  return safePublication(rows[0]);
 }
 async function isStorageObjectPresent(objectPath){
  const slash=objectPath.lastIndexOf("/");
  const prefix=objectPath.slice(0,slash+1),name=objectPath.slice(slash+1);
  let cursor=null;
  for(let page=0;page<10;page++){
   const listing=await cloudStorage.listObjects({prefix,limit:1000,cursor});
   if(!listing||!Array.isArray(listing.objects)||typeof listing.hasNext!=="boolean")throw new Error("Pending cleanup storage verification returned an invalid page.");
   if(listing.objects.some(item=>item?.name===name))return true;
   if(!listing.hasNext)return false;
   cursor=listing.nextCursor;
  }
  throw new Error("Pending cleanup storage verification exceeded its bounded page limit.");
 }
 async function reconcilePendingClaims(runId){
  const claims=await listPendingClaims(pendingClaimOffset);
  pendingClaimOffset=claims.length<objectLimit?0:pendingClaimOffset+claims.length;
  const summary={scanned:claims.length,completed:0,skipped:0,failed:0,offset:pendingClaimOffset};
  for(const claim of claims){
   try{
    if(!claim||!UUID.test(claim.id||"")||!UUID.test(claim.claim_token||"")||
       !UUID.test(claim.job_id||"")||!UUID.test(claim.owner_id||"")||
       !UUID.test(claim.publication_id||"")||
       claim.project_id!==null&&!UUID.test(claim.project_id||"")||
       typeof claim.object_path!=="string"){
     summary.skipped++;continue;
    }
    const publication=await getPublicationById(claim.publication_id);
    if(!publication||publication.job_id!==claim.job_id||publication.owner_id!==claim.owner_id||
       publication.project_id!==claim.project_id){
     summary.skipped++;continue;
    }
    const expectedPrefix=(publication.project_id||publication.owner_id)+"/"+publication.asset_id+"/";
    const filename=claim.object_path.startsWith(expectedPrefix)?claim.object_path.slice(expectedPrefix.length):"";
    const attempt=/^attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9]{1,12}$/i;
    if(!attempt.test(filename)){summary.skipped++;continue;}
    const job=await getJob(publication.job_id);
    if(!job||!TERMINAL_CLEANUP_STATES.has(job.status)||
       (job.lease_expires_at&&Date.parse(job.lease_expires_at)>now().getTime())){
     summary.skipped++;continue;
    }
    const referenceParams=new URLSearchParams({select:"object_path",object_path:"eq."+claim.object_path,limit:"1"});
    const references=await request("assets?"+referenceParams.toString());
    if(!Array.isArray(references))throw new Error("Pending cleanup reference lookup returned an invalid response.");
    const audit=createAuditFor(publication,runId);
    if(references.length){
     await audit.onEvent({type:"publication.cleanup_candidate_skipped",objectPath:claim.object_path,reason:"asset_reference_exists",claimId:claim.id,dryRun,at:now()});
     summary.skipped++;continue;
    }
    if(dryRun){
     await audit.onEvent({type:"publication.cleanup_candidate_skipped",objectPath:claim.object_path,reason:"cleanup_worker_dry_run",claimId:claim.id,dryRun:true,at:now()});
     summary.skipped++;continue;
    }
    await audit.onEvent({type:"publication.cleanup_candidate_eligible",objectPath:claim.object_path,claimId:claim.id,dryRun:false,at:now()});
    try{
     await cloudStorage.remove(claim.object_path);
    }catch(error){
     const missing=error?.status===404||error?.code==="CLOUD_STORAGE_HTTP_404";
     if(!missing||await isStorageObjectPresent(claim.object_path))throw error;
    }
    // Persist the removal evidence before completing the tombstone. If either
    // operation is interrupted, the still-claimed row is retried next cycle.
    await audit.onEvent({type:"publication.orphan_removed",objectPath:claim.object_path,claimId:claim.id,dryRun:false,at:now()});
    const completed=await rpc("complete_asset_publication_cleanup_v1",{p_claim_id:claim.id,p_claim_token:claim.claim_token});
    if(completed!==true)throw new Error("Pending cleanup claim completion was not confirmed.");
    summary.completed++;
   }catch(error){
    summary.failed++;
    onLog({kind:"pending_cleanup_reconciliation_failed",code:error?.code||"CLEANUP_RECONCILIATION_FAILED"});
   }
  }
  return summary;
 }
 let busy=false,lastRunAt=0;
 return Object.freeze({
  workerId:"publication-cleanup-"+randomUUID(),
  async checkReadiness(){
   const tables=["assets","jobs","asset_publications","asset_publication_cleanup_claims","publication_cleanup_audit_events"];
   for(const table of tables){const rows=await request(table+"?select=id&limit=0");if(!Array.isArray(rows))throw new Error("Publication cleanup readiness query returned an invalid response for "+table+".");}
   return{ready:true,tables};
  },
  async runCycle(){
   if(busy)return{skipped:true,reason:"cycle_busy"};
   const startedAt=now().getTime();
   if(lastRunAt&&startedAt-lastRunAt<pollIntervalMs)return{skipped:true,reason:"poll_interval"};
   busy=true;lastRunAt=startedAt;
   const runId=randomUUID(),results=[];
   try{
    const pendingClaims=await reconcilePendingClaims(runId);
    const publications=await listStalePublications(publicationOffset);
    publicationOffset=publications.length<publicationLimit?0:publicationOffset+publications.length;
    for(const publication of publications){
     const job=await getJob(publication.job_id);
     if(!job||!TERMINAL_CLEANUP_STATES.has(job.status)||(job.lease_expires_at&&Date.parse(job.lease_expires_at)>now().getTime())){
      results.push({publicationKey:publication.publication_key,status:"skipped_nonterminal_job"});
      continue;
     }
     const prefix=(publication.project_id||publication.owner_id)+"/"+publication.asset_id+"/";
     const cleanup=await createCleanupFor(publication,runId);
     const pages=[];
     const cursorKey=publication.owner_id+":"+(publication.project_id||"")+":"+publication.publication_key;
     let cursor=publicationCursors.get(cursorKey)||null,pageCount=0;
     do {
      const page=await cleanup.run({
       prefix,jobId:publication.job_id,ownerId:publication.owner_id,projectId:publication.project_id,
       publicationKey:publication.publication_key,olderThanMs,limit:objectLimit,cursor,dryRun,
       confirmDelete:!dryRun&&confirmDelete
      });
      pages.push(page);
      cursor=page.hasNext?page.nextCursor:null;
      pageCount++;
     } while(cursor&&pageCount<3);
     if(cursor)publicationCursors.set(cursorKey,cursor);else publicationCursors.delete(cursorKey);
     const first=pages[0];
     const result={
      ...first,
      pages:pages.length,
      scanned:pages.reduce((sum,page)=>sum+page.scanned,0),
      candidateCount:pages.reduce((sum,page)=>sum+page.candidateCount,0),
      eligibleCount:pages.reduce((sum,page)=>sum+page.eligibleCount,0),
      removedCount:pages.reduce((sum,page)=>sum+page.removedCount,0),
      skippedCount:pages.reduce((sum,page)=>sum+page.skippedCount,0),
      failureCount:pages.reduce((sum,page)=>sum+page.failureCount,0),
      eligible:pages.flatMap(page=>page.eligible),
      removed:pages.flatMap(page=>page.removed),
      skipped:pages.flatMap(page=>page.skipped),
      hasNext:Boolean(cursor),
      nextCursor:cursor
     };
     results.push({publicationKey:publication.publication_key,...result});
    }
    const summary={claimed:false,runId,dryRun,pendingClaims,publicationsScanned:publications.length,results};
    onLog({kind:"publication_cleanup_cycle",runId,dryRun,pendingClaims,publicationsScanned:publications.length,cleanupRuns:results.length});
    return summary;
   }finally{busy=false;}
  },
  async recoverExpired(){return 0;}
 });
}
