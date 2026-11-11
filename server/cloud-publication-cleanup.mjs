// Opt-in cleanup primitive only: callers must supply authoritative reference and lease checks.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTEMPT=/^attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9]{1,12}$/i;
const DAY_MS=24*60*60*1000;

function validatePrefix(prefix) {
  if(typeof prefix!=="string")throw new Error("Publication cleanup requires an exact asset prefix.");
  const parts=prefix.split("/");
  if(parts.length!==3||parts[2]!==""||!UUID.test(parts[0])||!UUID.test(parts[1])) {
    throw new Error("Publication cleanup prefix must contain exactly an owner-or-project UUID and asset UUID.");
  }
  return prefix;
}
function referenceSet(value) {
  if(value instanceof Set)return value;
  if(Array.isArray(value))return new Set(value);
  throw new Error("Publication cleanup reference lookup must return an array or Set of object paths.");
}

/**
 * Builds a conservative orphan-attempt cleanup service.
 *
 * The service never deletes by default. A destructive run requires:
 *   dryRun:false, confirmDelete:true, an exact asset prefix,
 *   an authoritative reference lookup, and an authoritative lease check.
 */
export function createCloudPublicationCleanup({
  storage,
  findReferencedPaths,
  isAttemptActive,
  claimCleanup,
  completeCleanup,
  onEvent=async()=>false,
  requireAudit=true,
  now=()=>new Date()
}={}) {
  if(!storage||typeof storage.listObjects!=="function"||typeof storage.remove!=="function") {
    throw new Error("Publication cleanup requires a private storage adapter with list and remove operations.");
  }
  if(typeof findReferencedPaths!=="function")throw new Error("Publication cleanup requires an authoritative asset-reference lookup.");
  if(typeof onEvent!=="function")throw new Error("Publication cleanup requires a durable audit event handler.");
  if(typeof requireAudit!=="boolean")throw new Error("Publication cleanup audit requirement must be boolean.");

  async function emit(event) {
    let stored;
    try { stored=await onEvent(Object.freeze({...event})); }
    catch {
      if(requireAudit)throw Object.assign(new Error("Publication cleanup audit persistence failed; cleanup is stopped."),{code:"CLOUD_PUBLICATION_CLEANUP_AUDIT_FAILED"});
      return false;
    }
    if(requireAudit&&stored!==true)throw Object.assign(new Error("Publication cleanup audit event was not durably acknowledged; cleanup is stopped."),{code:"CLOUD_PUBLICATION_CLEANUP_AUDIT_FAILED"});
    return stored===true;
  }
  async function recordSkip(skipped, candidate, reason, extra={}, at, dryRun=true) {
    const item={...candidate,reason,...extra};
    skipped.push(item);
    await emit({
      type:"publication.cleanup_candidate_skipped",
      objectPath:candidate.objectPath,
      createdAt:candidate.createdAt||null,
      reason,
      dryRun,
      ...(extra.claimId?{claimId:extra.claimId}:{}),
      at
    });
  }

  return Object.freeze({
    async run({
      prefix,
      jobId=null,
      ownerId=null,
      projectId=null,
      publicationKey=null,
      olderThanMs=DAY_MS,
      limit=100,
      cursor=null,
      dryRun=true,
      confirmDelete=false
    }={}) {
      prefix=validatePrefix(prefix);
      if(!Number.isSafeInteger(olderThanMs)||olderThanMs<DAY_MS||olderThanMs>30*DAY_MS) {
        throw new Error("Publication cleanup age must be between 24 hours and 30 days.");
      }
      if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("Publication cleanup limit must be between 1 and 100.");
      if(cursor!==null&&(typeof cursor!=="string"||!cursor||cursor.length>4096))throw new Error("Publication cleanup cursor is invalid.");
      if(typeof dryRun!=="boolean"||typeof confirmDelete!=="boolean")throw new Error("Publication cleanup safety flags must be boolean.");
      if(!dryRun&&!confirmDelete)throw new Error("Destructive publication cleanup requires explicit confirmation.");
      if(!dryRun&&(!UUID.test(jobId||"")||!UUID.test(ownerId||"")||(projectId!==null&&!UUID.test(projectId))||typeof publicationKey!=="string"||publicationKey.length<1||publicationKey.length>200)) {
        throw new Error("Destructive cleanup requires the exact job, owner, optional project, and publication key identity.");
      }
      if(!dryRun&&prefix.split("/")[0] !== (projectId||ownerId))throw new Error("Cleanup prefix does not match the publication owner/project scope.");
      if(!dryRun&&typeof isAttemptActive!=="function")throw new Error("Destructive cleanup requires an authoritative active-worker lease check.");
      if(!dryRun&&(typeof claimCleanup!=="function"||typeof completeCleanup!=="function"))throw new Error("Destructive cleanup requires durable database claim and completion callbacks.");

      const current=now();
      const nowMs=current instanceof Date?current.getTime():Date.parse(current);
      if(!Number.isFinite(nowMs))throw new Error("Publication cleanup clock returned an invalid time.");
      const cutoff=new Date(nowMs-olderThanMs).toISOString();
      const eventAt=new Date(nowMs).toISOString();
      const listing=await storage.listObjects({prefix,limit,cursor});
      if(!listing||!Array.isArray(listing.objects)||typeof listing.hasNext!=="boolean")throw new Error("Publication cleanup storage listing is invalid.");
      const entries=listing.objects;
      const candidates=[];
      const skipped=[];
      for(const entry of entries) {
        if(!entry||typeof entry.name!=="string"||!ATTEMPT.test(entry.name))continue;
        const objectPath=prefix+entry.name;
        const created=Date.parse(entry.createdAt||"");
        if(!Number.isFinite(created)) {
          await recordSkip(skipped,{objectPath},"created_at_unavailable",{},eventAt,dryRun);
          continue;
        }
        if(created>nowMs-olderThanMs)continue;
        candidates.push({objectPath,createdAt:new Date(created).toISOString()});
      }

      let referenced;
      try { referenced=referenceSet(await findReferencedPaths(candidates.map(item=>item.objectPath))); }
      catch(error) {
        const failure=new Error("Publication cleanup reference lookup failed; no objects were deleted.");
        failure.code="CLOUD_PUBLICATION_CLEANUP_REFERENCE_LOOKUP_FAILED";
        failure.cause=error;
        throw failure;
      }
      const eligible=[];
      for(const candidate of candidates) {
        if(referenced.has(candidate.objectPath)) {
          await recordSkip(skipped,candidate,"asset_reference_exists",{},eventAt,dryRun);
          continue;
        }
        if(typeof isAttemptActive!=="function") {
          await recordSkip(skipped,candidate,"lease_state_unavailable",{},eventAt,dryRun);
          continue;
        }
        let active;
        try { active=await isAttemptActive({prefix,objectPath:candidate.objectPath,createdAt:candidate.createdAt}); }
        catch { active=null; }
        if(active!==false) {
          await recordSkip(skipped,candidate,active===true?"active_worker_lease":"lease_state_unavailable",{},eventAt,dryRun);
          continue;
        }
        eligible.push(candidate);
        await emit({type:"publication.cleanup_candidate_eligible",objectPath:candidate.objectPath,createdAt:candidate.createdAt,dryRun,at:eventAt});
      }

      const removed=[];
      if(!dryRun) {
        for(const candidate of eligible) {
          let claim;
          try {
            claim=await claimCleanup({jobId,ownerId,projectId,publicationKey,prefix,objectPath:candidate.objectPath,createdAt:candidate.createdAt});
            if(!claim||typeof claim.claimId!=="string"||typeof claim.claimToken!=="string"||claim.status!=="claimed") {
              throw new Error("Durable cleanup claim was not granted.");
            }
          } catch {
            await recordSkip(skipped,candidate,"durable_cleanup_claim_failed",{},eventAt,dryRun);
            continue;
          }
          try {
            await storage.remove(candidate.objectPath);
            removed.push(candidate);
          } catch {
            // Keep the durable claim. A retry can safely repeat the Storage API
            // removal with the same claim token and then complete the tombstone.
            await recordSkip(skipped,candidate,"storage_remove_failed",{claimId:claim.claimId},eventAt,dryRun);
            continue;
          }
          try {
            const completed=await completeCleanup({...claim,jobId,ownerId,projectId,publicationKey,prefix,objectPath:candidate.objectPath});
            if(completed!==true)throw new Error("Durable cleanup claim completion was not confirmed.");
          } catch {
            await recordSkip(skipped,candidate,"cleanup_claim_completion_failed",{claimId:claim.claimId},eventAt,dryRun);
            continue;
          }
          await emit({type:"publication.orphan_removed",prefix,objectPath:candidate.objectPath,createdAt:candidate.createdAt,claimId:claim.claimId,dryRun,at:eventAt});
        }
      }
      const result={
        prefix,cutoff,scanned:entries.length,hasNext:listing.hasNext,nextCursor:listing.nextCursor||null,candidateCount:candidates.length,
        eligibleCount:eligible.length,removedCount:removed.length,
        dryRun,confirmDelete,eligible,removed,skipped
      };
      result.skippedCount=skipped.length;
      result.failureCount=skipped.filter(item=>item.reason.endsWith("_failed")).length;
      await emit({type:"publication.cleanup_completed",prefix,dryRun,scanned:result.scanned,candidateCount:result.candidateCount,eligibleCount:result.eligibleCount,removedCount:result.removedCount,skippedCount:result.skippedCount,failureCount:result.failureCount,at:eventAt});
      return result;
    }
  });
}
