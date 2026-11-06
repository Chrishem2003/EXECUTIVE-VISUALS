const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTEMPT=/^attempt-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[A-Za-z0-9]{1,12}$/i;
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
  onEvent=()=>{},
  now=()=>new Date()
}={}) {
  if(!storage||typeof storage.listObjects!=="function"||typeof storage.remove!=="function") {
    throw new Error("Publication cleanup requires a private storage adapter with list and remove operations.");
  }
  if(typeof findReferencedPaths!=="function")throw new Error("Publication cleanup requires an authoritative asset-reference lookup.");
  if(typeof onEvent!=="function")throw new Error("Publication cleanup event handler must be a function.");

  async function emit(event) {
    try { await onEvent(Object.freeze({...event})); }
    catch { /* Audit callback failure must never broaden cleanup or hide a deletion result. */ }
  }

  return Object.freeze({
    async run({
      prefix,
      olderThanMs=DAY_MS,
      limit=100,
      offset=0,
      dryRun=true,
      confirmDelete=false
    }={}) {
      prefix=validatePrefix(prefix);
      if(!Number.isSafeInteger(olderThanMs)||olderThanMs<DAY_MS||olderThanMs>30*DAY_MS) {
        throw new Error("Publication cleanup age must be between 24 hours and 30 days.");
      }
      if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("Publication cleanup limit must be between 1 and 100.");
      if(!Number.isInteger(offset)||offset<0||offset>100000)throw new Error("Publication cleanup offset is invalid.");
      if(typeof dryRun!=="boolean"||typeof confirmDelete!=="boolean")throw new Error("Publication cleanup safety flags must be boolean.");
      if(!dryRun&&!confirmDelete)throw new Error("Destructive publication cleanup requires explicit confirmation.");
      if(!dryRun&&typeof isAttemptActive!=="function")throw new Error("Destructive cleanup requires an authoritative active-worker lease check.");

      const current=now();
      const nowMs=current instanceof Date?current.getTime():Date.parse(current);
      if(!Number.isFinite(nowMs))throw new Error("Publication cleanup clock returned an invalid time.");
      const cutoff=new Date(nowMs-olderThanMs).toISOString();
      const entries=await storage.listObjects({prefix,limit,offset});
      const candidates=[];
      const skipped=[];
      for(const entry of entries) {
        if(!entry||typeof entry.name!=="string"||!ATTEMPT.test(entry.name))continue;
        const objectPath=prefix+entry.name;
        const created=Date.parse(entry.createdAt||"");
        if(!Number.isFinite(created)) {
          skipped.push({objectPath,reason:"created_at_unavailable"});
          continue;
        }
        if(created>nowMs-olderThanMs)continue;
        candidates.push({objectPath,createdAt:new Date(created).toISOString()});
      }

      const referenced=referenceSet(await findReferencedPaths(candidates.map(item=>item.objectPath)));
      const eligible=[];
      for(const candidate of candidates) {
        if(referenced.has(candidate.objectPath)) {
          skipped.push({...candidate,reason:"asset_reference_exists"});
          continue;
        }
        if(typeof isAttemptActive!=="function") {
          skipped.push({...candidate,reason:"lease_state_unavailable"});
          continue;
        }
        let active;
        try { active=await isAttemptActive({prefix,objectPath:candidate.objectPath,createdAt:candidate.createdAt}); }
        catch { active=null; }
        if(active!==false) {
          skipped.push({...candidate,reason:active===true?"active_worker_lease":"lease_state_unavailable"});
          continue;
        }
        eligible.push(candidate);
      }

      const removed=[];
      if(!dryRun) {
        for(const candidate of eligible) {
          try {
            await storage.remove(candidate.objectPath);
            removed.push(candidate);
            await emit({type:"publication.orphan_removed",prefix,objectPath:candidate.objectPath,createdAt:candidate.createdAt,at:new Date(nowMs).toISOString()});
          } catch {
            skipped.push({...candidate,reason:"storage_remove_failed"});
          }
        }
      }
      const result={
        prefix,cutoff,scanned:entries.length,candidateCount:candidates.length,
        eligibleCount:eligible.length,removedCount:removed.length,
        dryRun,confirmDelete,eligible,removed,skipped
      };
      await emit({type:"publication.cleanup_completed",prefix,dryRun,scanned:result.scanned,candidateCount:result.candidateCount,eligibleCount:result.eligibleCount,removedCount:result.removedCount,skippedCount:skipped.length,at:new Date(nowMs).toISOString()});
      return result;
    }
  });
}
