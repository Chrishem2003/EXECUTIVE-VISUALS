import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";

const ACTIVE_STATES = new Set(["UPLOADING","OUTCOME_UNKNOWN","OBJECT_VERIFIED"]);
const TERMINAL_STATES = new Set(["REGISTERED","FAILED","QUARANTINED"]);
const fail = (message, code) => Object.assign(new Error(message), { code });

function validSessionUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "storage.googleapis.com" &&
      !url.username && !url.password && !url.hash &&
      url.pathname.startsWith("/upload/storage/v1/");
  } catch { return false; }
}
function validToken(value) {
  return typeof value === "string" && value.length >= 20 && value.length <= 8192 && !/\s/.test(value);
}
function metadataMatches(metadata, attempt) {
  const custom = metadata?.metadata || {};
  return metadata?.bucket === attempt.bucket &&
    metadata?.name === attempt.objectName &&
    /^\d{1,30}$/.test(String(metadata?.generation || "")) &&
    /^\d{1,30}$/.test(String(metadata?.metageneration || "")) &&
    String(metadata?.size || "") === String(attempt.sizeBytes) &&
    metadata?.contentType === attempt.mediaType &&
    custom.executivevisualsassetid === attempt.assetId &&
    custom.executivevisualsownerid === attempt.ownerId &&
    (custom.executivevisualsprojectid || null) === attempt.projectId &&
    custom.executivevisualssha256 === attempt.sha256 &&
    typeof metadata?.crc32c === "string" && metadata.crc32c === custom.executivevisualscrc32c &&
    /^[A-Za-z0-9+/]{6}==$/.test(String(custom.executivevisualscrc32c || ""));
}
function parsePersistedOffset(range, sizeBytes) {
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(String(range).trim());
  if (!match) throw fail("GCS returned an invalid resumable upload range.", "GEMINI_GCS_RECOVERY_RANGE_INVALID");
  const last = Number(match[1]);
  if (!Number.isSafeInteger(last) || last < 0 || last >= sizeBytes) {
    throw fail("GCS returned an out-of-bounds resumable upload range.", "GEMINI_GCS_RECOVERY_RANGE_INVALID");
  }
  return last + 1;
}

/**
 * Reconciles durable GCS mirror attempts. Session URIs are treated as bearer
 * credentials: never logged, returned, or sent to any host other than GCS.
 * The worker is opt-in and has no scheduler or production side effects.
 */
export function createGoogleGeminiGcsMirrorRecoveryWorker({
  attemptRepository,
  sourceRepository,
  loadPrivateAsset,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => new Date(),
  maxBytes = 250 * 1024 * 1024,
  timeoutMs = 120000,
  maxAttempts = 100
} = {}) {
  if (!attemptRepository || typeof attemptRepository.listRecoveryAttempts !== "function" ||
      typeof attemptRepository.claimRecoveryAttempt !== "function" ||
      typeof attemptRepository.releaseRecoveryAttempt !== "function" ||
      typeof attemptRepository.transition !== "function") {
    throw new TypeError("GCS recovery requires the durable lease-fenced attempt repository.");
  }
  if (!sourceRepository || typeof sourceRepository.findActiveSource !== "function" || typeof sourceRepository.recordVerifiedSource !== "function") {
    throw new TypeError("GCS recovery requires the governed source registry.");
  }
  if (typeof loadPrivateAsset !== "function" || typeof getAccessToken !== "function" ||
      typeof fetchImpl !== "function") {
    throw new TypeError("GCS recovery requires private asset materialization, OAuth and fetch.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024 * 1024 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000 ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 500 ||
      typeof now !== "function") {
    throw new TypeError("GCS recovery worker limits are invalid.");
  }
  const projectId = String(env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw fail("Configure a valid Google Cloud project ID.", "GEMINI_GCS_CONFIG_MISSING");
  }
  const allowedBuckets = new Set(String(env.GEMINI_GCS_ALLOWED_BUCKETS || "").split(",").map(x=>x.trim()).filter(Boolean));
  if (!allowedBuckets.size || [...allowedBuckets].some(x=>!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(x))) {
    throw fail("Configure an explicit GCS bucket allowlist.", "GEMINI_GCS_BUCKET_ALLOWLIST_MISSING");
  }

  async function token() {
    let value;
    try { value = await getAccessToken({ projectId, scopes:["https://www.googleapis.com/auth/devstorage.read_write","https://www.googleapis.com/auth/cloud-platform"] }); }
    catch { throw fail("Google Cloud OAuth token acquisition failed.", "GEMINI_GCS_OAUTH_FAILED"); }
    if (!validToken(value)) throw fail("Google Cloud OAuth token provider returned an invalid token.", "GEMINI_GCS_OAUTH_FAILED");
    return value;
  }
  async function request(url, { method="GET", accessToken, body, headers={} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response = await fetchImpl(url,{
        method, redirect:"error", signal:controller.signal,
        headers:{...(accessToken?{authorization:"Bearer "+accessToken,"x-goog-user-project":projectId}:{}),...headers},
        ...(body===undefined?{}:{body}),
        ...(body && typeof body==="object" && typeof body.pipe==="function"?{duplex:"half"}:{})
      });
      const raw = await response.text();
      if (Buffer.byteLength(raw,"utf8")>256*1024) throw fail("GCS recovery response is too large.","GEMINI_GCS_RECOVERY_RESPONSE_INVALID");
      let data=null;
      if(raw){try{data=JSON.parse(raw);}catch{if(response.ok)throw fail("GCS recovery response is invalid.","GEMINI_GCS_RECOVERY_RESPONSE_INVALID");}}
      return {response,data};
    } catch(error) {
      if(error?.name==="AbortError") throw fail("GCS recovery request timed out.","GEMINI_GCS_RECOVERY_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function readMetadata(attempt, accessToken) {
    const url="https://storage.googleapis.com/storage/v1/b/"+encodeURIComponent(attempt.bucket)+
      "/o/"+encodeURIComponent(attempt.objectName)+
      "?fields=bucket,name,generation,metageneration,size,contentType,crc32c,metadata";
    const {response,data}=await request(url,{accessToken});
    if(!response.ok) {
      const error=fail("GCS object metadata lookup failed (HTTP "+response.status+").","GEMINI_GCS_RECOVERY_METADATA_LOOKUP_FAILED");
      error.status=response.status; throw error;
    }
    return data;
  }
  async function verifyAndRegister(attempt, leaseToken, accessToken, results) {
    const metadata=await readMetadata(attempt,accessToken);
    if(!metadataMatches(metadata,attempt)) {
      await attemptRepository.transition({
        attemptId:attempt.id,expectedState:attempt.state,state:"QUARANTINED",
        errorCode:"GEMINI_GCS_RECOVERY_METADATA_MISMATCH",leaseToken
      });
      results.push({attemptId:attempt.id,status:"metadata_mismatch_quarantined"});
      return;
    }
    const generation=String(metadata.generation),metageneration=String(metadata.metageneration);
    if(attempt.state!=="OBJECT_VERIFIED") {
      await attemptRepository.transition({
        attemptId:attempt.id,expectedState:attempt.state,state:"OBJECT_VERIFIED",
        generation,metageneration,leaseToken
      });
    }
    const sourceScope={assetId:attempt.assetId,ownerId:attempt.ownerId,projectId:attempt.projectId};
    const existing=await sourceRepository.findActiveSource(sourceScope);
    if(existing) {
      const same=existing.bucket===attempt.bucket && existing.objectName===attempt.objectName &&
        existing.generation===generation && existing.metageneration===metageneration &&
        existing.sizeBytes===attempt.sizeBytes && existing.mediaType===attempt.mediaType &&
        existing.sha256===attempt.sha256;
      if(!same) {
        await attemptRepository.transition({
          attemptId:attempt.id,expectedState:"OBJECT_VERIFIED",state:"QUARANTINED",
          errorCode:"GEMINI_GCS_RECOVERY_ACTIVE_SOURCE_CONFLICT",leaseToken
        });
        results.push({attemptId:attempt.id,status:"active_source_conflict_quarantined"});
        return;
      }
    } else {
      await sourceRepository.recordVerifiedSource({
        ...sourceScope,bucket:attempt.bucket,objectName:attempt.objectName,generation,metageneration,
        sizeBytes:attempt.sizeBytes,mediaType:attempt.mediaType,sha256:attempt.sha256
      });
    }
    await attemptRepository.transition({
      attemptId:attempt.id,expectedState:"OBJECT_VERIFIED",state:"REGISTERED",
      generation,metageneration,leaseToken
    });
    results.push({attemptId:attempt.id,status:"registered"});
  }
  async function quarantine(attempt,leaseToken,code,status,results) {
    await attemptRepository.transition({
      attemptId:attempt.id,expectedState:attempt.state,state:"QUARANTINED",
      errorCode:code,leaseToken
    });
    results.push({attemptId:attempt.id,status});
  }

  return Object.freeze({
    async run({before=now().toISOString(),limit=100}={}) {
      if(!Number.isInteger(limit)||limit<1||limit>maxAttempts||!Number.isFinite(Date.parse(before))) {
        throw fail("GCS recovery query is invalid.","GEMINI_GCS_RECOVERY_QUERY_INVALID");
      }
      const attempts=await attemptRepository.listRecoveryAttempts({before,limit});
      const results=[];
      for(const attempt of attempts) {
        if(!ACTIVE_STATES.has(attempt.state)||!allowedBuckets.has(attempt.bucket)||
            !validSessionUri(attempt.sessionUri) && attempt.state!=="OBJECT_VERIFIED" ||
            !Number.isSafeInteger(attempt.sizeBytes)||attempt.sizeBytes<1||attempt.sizeBytes>maxBytes) {
          results.push({attemptId:attempt.id,status:"invalid_attempt_skipped"});
          continue;
        }
        let leaseToken=null;
        try {
          leaseToken=await attemptRepository.claimRecoveryAttempt({attemptId:attempt.id,expectedState:attempt.state});
          if(!leaseToken){results.push({attemptId:attempt.id,status:"already_claimed"});continue;}
          const accessToken=await token();
          if(attempt.state==="OBJECT_VERIFIED") {
            await verifyAndRegister(attempt,leaseToken,accessToken,results);
            continue;
          }
          if(!attempt.sessionExpiresAt||!Number.isFinite(Date.parse(attempt.sessionExpiresAt))||
              Date.parse(attempt.sessionExpiresAt)<=now().getTime()) {
            await quarantine(attempt,leaseToken,"GEMINI_GCS_RECOVERY_SESSION_EXPIRED","session_expired_quarantined",results);
            continue;
          }
          const status=await request(attempt.sessionUri,{
            method:"PUT",headers:{"content-length":"0","content-range":"bytes */"+attempt.sizeBytes}
          });
          if(status.response.status===200||status.response.status===201) {
            await verifyAndRegister(attempt,leaseToken,accessToken,results);
            continue;
          }
          if(status.response.status!==308) {
            if([400,404,410,412].includes(status.response.status)) {
              await quarantine(attempt,leaseToken,"GEMINI_GCS_RECOVERY_SESSION_REJECTED","session_rejected_quarantined",results);
              continue;
            }
            const error=fail("GCS resumable session status could not be confirmed (HTTP "+status.response.status+").","GEMINI_GCS_RECOVERY_STATUS_UNKNOWN");
            error.status=status.response.status; throw error;
          }
          const offset=parsePersistedOffset(status.response.headers.get("range"),attempt.sizeBytes);
          if(offset>=attempt.sizeBytes) {
            await quarantine(attempt,leaseToken,"GEMINI_GCS_RECOVERY_RANGE_COMPLETE_BUT_SESSION_OPEN","session_range_inconsistent_quarantined",results);
            continue;
          }
          const materialized=await loadPrivateAsset({
            assetId:attempt.assetId,ownerId:attempt.ownerId,projectId:attempt.projectId
          });
          if(!materialized||typeof materialized.cleanup!=="function"||typeof materialized.path!=="string") {
            throw fail("Private asset materializer returned an invalid receipt.","GEMINI_GCS_RECOVERY_SOURCE_INVALID");
          }
          try {
            const fileStat=await stat(materialized.path);
            const digest=createHash("sha256");
            for await(const chunk of createReadStream(materialized.path)) digest.update(chunk);
            const actualHash=digest.digest("hex");
            if(!fileStat.isFile()||fileStat.size!==attempt.sizeBytes||
                materialized.size!==attempt.sizeBytes||materialized.sha256!==attempt.sha256||actualHash!==attempt.sha256) {
              await quarantine(attempt,leaseToken,"GEMINI_GCS_RECOVERY_SOURCE_MISMATCH","source_mismatch_quarantined",results);
              continue;
            }
            const stream=createReadStream(materialized.path,{start:offset});
            const upload=await request(attempt.sessionUri,{
              method:"PUT",body:stream,
              headers:{
                "content-type":attempt.mediaType,
                "content-length":String(attempt.sizeBytes-offset),
                "content-range":"bytes "+offset+"-"+(attempt.sizeBytes-1)+"/"+attempt.sizeBytes
              }
            });
            if(upload.response.status===200||upload.response.status===201) {
              await verifyAndRegister(attempt,leaseToken,accessToken,results);
            } else if(upload.response.status===308) {
              await attemptRepository.releaseRecoveryAttempt({attemptId:attempt.id,leaseToken});
              leaseToken=null;
              results.push({attemptId:attempt.id,status:"partial_upload_retry_pending"});
            } else if([400,404,410,412].includes(upload.response.status)) {
              await quarantine(attempt,leaseToken,"GEMINI_GCS_RECOVERY_RESUME_REJECTED","resume_rejected_quarantined",results);
            } else {
              const error=fail("GCS resumable upload could not be completed (HTTP "+upload.response.status+").","GEMINI_GCS_RECOVERY_RESUME_FAILED");
              error.status=upload.response.status; throw error;
            }
          } finally { try { await materialized.cleanup(); } catch { results.push({attemptId:attempt.id,status:"temporary_cleanup_pending"}); } }
        } catch(error) {
          if(leaseToken) {
            try { await attemptRepository.releaseRecoveryAttempt({attemptId:attempt.id,leaseToken}); } catch {}
          }
          results.push({attemptId:attempt.id,status:"retry_pending",errorCode:error.code||"GEMINI_GCS_RECOVERY_FAILED"});
        }
      }
      return Object.freeze({
        scanned:attempts.length,
        registered:results.filter(x=>x.status==="registered").length,
        quarantined:results.filter(x=>x.status.endsWith("_quarantined")).length,
        retryPending:results.filter(x=>x.status==="retry_pending"||x.status==="partial_upload_retry_pending").length,
        alreadyClaimed:results.filter(x=>x.status==="already_claimed").length,
        cleanupPending:results.filter(x=>x.status==="temporary_cleanup_pending").length,
        results:Object.freeze(results)
      });
    }
  });
}
