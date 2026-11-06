import { randomUUID } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES=new Set([
  "publication.cleanup_candidate_eligible",
  "publication.cleanup_candidate_skipped",
  "publication.orphan_removed",
  "publication.cleanup_completed"
]);

function apiOrigin(value) {
  let parsed;
  try { parsed=new URL(value); }
  catch { throw new Error("Publication audit URL must be an absolute URL."); }
  const local=["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname.toLowerCase());
  if ((parsed.protocol!=="https:"&&!(local&&parsed.protocol==="http:"))||parsed.username||parsed.password||parsed.search||parsed.hash) {
    throw new Error("Publication audit URL must use HTTPS and contain no credentials, query or fragment.");
  }
  return parsed.origin;
}

function optionalUuid(value,label) {
  if(value===null||value===undefined||value==="")return null;
  if(typeof value!=="string"||!UUID.test(value))throw new Error("Publication audit "+label+" must be a UUID.");
  return value;
}

function safeObjectPath(value,scopeId) {
  if(value===null||value===undefined)return null;
  if(typeof value!=="string"||value.length>1024)throw new Error("Publication audit object path is invalid.");
  const match=value.match(/^([0-9a-f-]{36})\/([0-9a-f-]{36})\/(attempt-[0-9a-f-]{36}\.[A-Za-z0-9]{1,12})$/i);
  if(!match||!UUID.test(match[1])||!UUID.test(match[2])||match[1].toLowerCase()!==scopeId.toLowerCase()||
     !/^attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9]{1,12}$/i.test(match[3])) {
    throw new Error("Publication audit object path is outside the exact owner/project attempt scope.");
  }
  return value;
}

/**
 * Supabase REST sink for append-only publication cleanup evidence.
 * The service-role key is server-only; no table mutation other than INSERT is used.
 */
export function createCloudPublicationAuditSink({
  url=process.env.SUPABASE_URL,
  serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  ownerId,
  projectId=null,
  jobId=null,
  publicationKey=null,
  actorId=null,
  actorType="system",
  runId=randomUUID(),
  fetchImpl=globalThis.fetch,
  timeoutMs=10000,
  now=()=>new Date(),
  onFailure=()=>{}
}={}) {
  if(!url||!serviceRoleKey)throw new Error("Publication audit sink requires server-side Supabase URL and service-role key.");
  if(typeof fetchImpl!=="function")throw new Error("Publication audit sink requires fetch.");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw new Error("Publication audit timeout must be between 1000 and 60000 milliseconds.");
  if(typeof onFailure!=="function")throw new Error("Publication audit failure callback must be a function.");
  const base=apiOrigin(url);
  const owner=optionalUuid(ownerId,"owner ID");
  if(!owner)throw new Error("Publication audit sink requires an owner ID.");
  const project=optionalUuid(projectId,"project ID");
  const job=optionalUuid(jobId,"job ID");
  const actor=optionalUuid(actorId,"actor ID");
  const correlation=optionalUuid(runId,"run ID");
  if(!correlation)throw new Error("Publication audit sink requires a run ID.");
  if(!["system","user","admin"].includes(actorType))throw new Error("Publication audit actor type is invalid.");
  if(publicationKey!==null&&(typeof publicationKey!=="string"||publicationKey.length<1||publicationKey.length>200)) {
    throw new Error("Publication audit publication key is invalid.");
  }
  let attempted=0,stored=0,failed=0,lastFailureCode=null;

  async function onEvent(event) {
    if(!event||!EVENT_TYPES.has(event.type))throw new Error("Publication audit event type is not allowed.");
    if(typeof event.dryRun!=="boolean")throw new Error("Publication audit event must declare its dry-run mode.");
    const scope=project||owner;
    const objectPath=safeObjectPath(event.objectPath,scope);
    const claimId=optionalUuid(event.claimId,"claim ID");
    const at=event.at===undefined?now():new Date(event.at);
    if(!(at instanceof Date)||!Number.isFinite(at.getTime()))throw new Error("Publication audit event timestamp is invalid.");
    const reason=event.reason===undefined?null:String(event.reason);
    if(reason!==null&&(reason.length<1||reason.length>100))throw new Error("Publication audit reason is invalid.");
    const details={};
    for(const key of ["createdAt","scanned","candidateCount","eligibleCount","removedCount","skippedCount","failureCount"]) {
      if(event[key]!==undefined)details[key]=event[key];
    }
    const payload={
      run_id:correlation,
      event_type:event.type,
      actor_type:actorType,
      actor_id:actor,
      job_id:job,
      owner_id:owner,
      project_id:project,
      publication_key:publicationKey,
      claim_id:claimId,
      object_path:objectPath,
      reason,
      dry_run:event.dryRun,
      details,
      occurred_at:at.toISOString()
    };
    attempted++;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(base+"/rest/v1/publication_cleanup_audit_events",{
        method:"POST",
        headers:{
          apikey:serviceRoleKey,
          authorization:"Bearer "+serviceRoleKey,
          "content-type":"application/json",
          "content-profile":"executive_visuals",
          prefer:"return=minimal"
        },
        body:JSON.stringify(payload),
        signal:controller.signal
      });
      if(!response.ok) {
        const error=new Error("Publication audit storage rejected an event (HTTP "+response.status+").");
        error.code="PUBLICATION_AUDIT_HTTP_"+response.status;
        throw error;
      }
      stored++;
      return true;
    } catch(error) {
      failed++;
      lastFailureCode=error?.code||"PUBLICATION_AUDIT_TRANSPORT_FAILED";
      try { await onFailure(Object.freeze({eventType:event.type,code:lastFailureCode})); } catch {}
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    onEvent,
    getStatus(){return Object.freeze({attempted,stored,failed,lastFailureCode});}
  });
}


/**
 * Converts the audit sink's transport-failure result into bounded retries.
 * The cleanup service requires a literal true acknowledgement before it
 * proceeds to a destructive storage operation.
 */
export function createCloudPublicationAuditHandler({
  sink,
  maxAttempts=3,
  retryDelayMs=250,
  onRetry=()=>{}
}={}) {
  if(!sink||typeof sink.onEvent!=="function")throw new Error("Publication audit handler requires a compatible audit sink.");
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5)throw new Error("Publication audit retry count must be between 1 and 5.");
  if(!Number.isInteger(retryDelayMs)||retryDelayMs<0||retryDelayMs>30000)throw new Error("Publication audit retry delay is invalid.");
  if(typeof onRetry!=="function")throw new Error("Publication audit retry observer must be a function.");
  return Object.freeze({
    async onEvent(event) {
      for(let attempt=1;attempt<=maxAttempts;attempt++) {
        const stored=await sink.onEvent(event);
        if(stored===true)return true;
        if(attempt<maxAttempts) {
          try { await onRetry(Object.freeze({eventType:event?.type,attempt,nextAttempt:attempt+1})); } catch {}
          if(retryDelayMs>0)await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
        }
      }
      throw Object.assign(new Error("Publication audit event could not be persisted after bounded retries."),{code:"CLOUD_PUBLICATION_AUDIT_RETRIES_EXHAUSTED"});
    }
  });
}
