import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from "node:crypto";

const TABLE = "google_gcs_mirror_attempts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(["PREPARED","UPLOADING","OUTCOME_UNKNOWN","OBJECT_VERIFIED","REGISTERED","FAILED","QUARANTINED"]);
const ACTIVE = new Set(["UPLOADING","OUTCOME_UNKNOWN","OBJECT_VERIFIED"]);
const fail = (message, code) => Object.assign(new Error(message), { code });

function keyFromEnv(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}=$/.test(value)) {
    throw fail("GCS session encryption key must be a base64-encoded 32-byte key.", "GEMINI_GCS_SESSION_KEY_INVALID");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw fail("GCS session encryption key must contain exactly 32 bytes.", "GEMINI_GCS_SESSION_KEY_INVALID");
  return key;
}
function encryptSession(uri, key, aad) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "https:" || parsed.hostname !== "storage.googleapis.com" ||
      parsed.username || parsed.password || parsed.hash || !parsed.pathname.startsWith("/upload/storage/v1/")) {
    throw fail("GCS resumable session URI is invalid.", "GEMINI_GCS_SESSION_URI_INVALID");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(uri, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
function decryptSession(value, key, aad) {
  try {
    const [ivText, tagText, ciphertextText, extra] = String(value || "").split(".");
    if (!ivText || !tagText || !ciphertextText || extra) throw new Error("invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const uri = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" || parsed.hostname !== "storage.googleapis.com" || parsed.username || parsed.password || parsed.hash ||
        !parsed.pathname.startsWith("/upload/storage/v1/")) throw new Error("invalid session URI");
    return uri;
  } catch {
    throw fail("Stored GCS session URI could not be authenticated or decrypted.", "GEMINI_GCS_SESSION_CIPHERTEXT_INVALID");
  }
}
function mapRow(row, key) {
  const result = {
    id: row.id, attemptKey: row.attempt_key, assetId: row.asset_id, ownerId: row.owner_id,
    projectId: row.project_id || null, bucket: row.bucket, objectName: row.object_name,
    mediaType: row.media_type, sizeBytes: Number(row.byte_size), sha256: row.sha256,
    state: row.state, sessionExpiresAt: row.session_expires_at || null,
    generation: row.verified_generation || null, metageneration: row.verified_metageneration || null,
    lastErrorCode: row.last_error_code || null, attemptCount: Number(row.attempt_count || 1),
    updatedAt: row.updated_at, reconciledAt: row.reconciled_at || null
  };
  if (row.session_uri_ciphertext) result.sessionUri = decryptSession(row.session_uri_ciphertext, key, row.id);
  return result;
}

/** Service-role-only GCS mirror attempt store. Session URIs are AES-256-GCM encrypted at rest. */
export function createGoogleGeminiGcsMirrorAttemptRepository({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  encryptionKey = process.env.GEMINI_GCS_SESSION_ENCRYPTION_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  now = () => new Date()
} = {}) {
  if (!url || !serviceRoleKey || typeof fetchImpl !== "function") throw new TypeError("GCS mirror attempt repository requires server-side Supabase credentials and fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("GCS mirror attempt timeout is invalid.");
  const key = keyFromEnv(encryptionKey);
  let base;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "https:" && !["localhost","127.0.0.1","[::1]"].includes(parsed.hostname)) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    base = parsed.origin;
  } catch { throw new Error("GCS mirror attempt repository URL must be safe HTTPS."); }

  async function request(query, { method = "GET", body, prefer } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(base + "/rest/v1/" + TABLE + query, {
        method, redirect: "error", signal: controller.signal,
        headers: {
          apikey: serviceRoleKey, authorization: "Bearer " + serviceRoleKey,
          "accept-profile": "executive_visuals", "content-profile": "executive_visuals",
          accept: "application/json", ...(body === undefined ? {} : {"content-type":"application/json"}),
          ...(prefer ? {prefer} : {})
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw fail("GCS attempt response is too large.", "GEMINI_GCS_ATTEMPT_RESPONSE_INVALID");
      let data = null;
      if (raw) { try { data = JSON.parse(raw); } catch { if (response.ok) throw fail("GCS attempt response is invalid.", "GEMINI_GCS_ATTEMPT_RESPONSE_INVALID"); } }
      if (!response.ok) {
        const error = fail("GCS mirror attempt repository failed (HTTP " + response.status + ").", "GEMINI_GCS_ATTEMPT_REPOSITORY_FAILED");
        error.status = response.status; throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw fail("GCS mirror attempt repository timed out.", "GEMINI_GCS_ATTEMPT_TIMEOUT");
      throw error;
    } finally { clearTimeout(timer); }
  }

  const select = "id,attempt_key,asset_id,owner_id,project_id,bucket,object_name,media_type,byte_size,sha256,state,session_uri_ciphertext,session_expires_at,verified_generation,verified_metageneration,last_error_code,attempt_count,lease_token,lease_expires_at,updated_at,reconciled_at";
  function validScope(input) {
    if (!UUID.test(String(input?.assetId || "")) || !UUID.test(String(input?.ownerId || "")) ||
        (input?.projectId != null && !UUID.test(String(input.projectId))) ||
        !HASH.test(String(input?.sha256 || "")) || !Number.isSafeInteger(input?.sizeBytes) ||
        input.sizeBytes < 1 || typeof input.bucket !== "string" || typeof input.objectName !== "string") {
      throw fail("GCS mirror attempt scope is invalid.", "GEMINI_GCS_ATTEMPT_INVALID");
    }
  }

  return Object.freeze({
    async createAttempt(input) {
      validScope(input);
      const id = randomUUID();
      const attemptKey = createHash("sha256").update([input.assetId,input.ownerId,input.projectId || "",input.bucket,input.objectName,input.sha256].join("\n")).digest("hex");
      const rows = await request("?select=" + select, {
        method:"POST", prefer:"resolution=ignore-duplicates,return=representation",
        body: {
          id, attempt_key:attemptKey, asset_id:input.assetId, owner_id:input.ownerId,
          project_id:input.projectId || null, bucket:input.bucket, object_name:input.objectName,
          media_type:input.mediaType, byte_size:input.sizeBytes, sha256:input.sha256, state:"PREPARED"
        }
      });
      if (!Array.isArray(rows) || rows.length !== 1) throw fail("GCS mirror attempt was not uniquely created.", "GEMINI_GCS_ATTEMPT_CREATE_FAILED");
      return mapRow(rows[0], key);
    },
    async recordSession({attemptId, sessionUri, expiresAt}) {
      if (!UUID.test(String(attemptId || "")) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now().getTime()) {
        throw fail("GCS mirror session expiry is invalid.", "GEMINI_GCS_ATTEMPT_INVALID");
      }
      const ciphertext = encryptSession(sessionUri, key, attemptId);
      const params = new URLSearchParams({id:"eq."+attemptId,state:"eq.PREPARED",select});
      const rows = await request("?"+params.toString(), {method:"PATCH",prefer:"return=representation",body:{
        state:"UPLOADING",session_uri_ciphertext:ciphertext,session_expires_at:new Date(expiresAt).toISOString(),updated_at:now().toISOString()
      }});
      if (!Array.isArray(rows) || rows.length !== 1) throw fail("GCS mirror session could not be durably recorded.", "GEMINI_GCS_ATTEMPT_SESSION_PERSIST_FAILED");
      return mapRow(rows[0], key);
    },
    async transition({attemptId, expectedState, state, generation, metageneration, errorCode, leaseToken} = {}) {
      if (!UUID.test(String(attemptId || "")) || !STATES.has(state) || !STATES.has(expectedState)) throw fail("GCS mirror attempt transition is invalid.", "GEMINI_GCS_ATTEMPT_TRANSITION_INVALID");
      const params = new URLSearchParams({id:"eq."+attemptId,state:"eq."+expectedState,select});
      if (leaseToken) params.set("lease_token","eq."+leaseToken);
      const body = {state,updated_at:now().toISOString()};
      if (generation !== undefined) body.verified_generation = generation;
      if (metageneration !== undefined) body.verified_metageneration = metageneration;
      if (errorCode !== undefined) body.last_error_code = errorCode;
      if (leaseToken) { body.lease_token = null; body.lease_expires_at = null; body.reconciled_at = now().toISOString(); }
      const rows = await request("?"+params.toString(), {method:"PATCH",prefer:"return=representation",body});
      if (!Array.isArray(rows) || rows.length !== 1) throw fail("GCS mirror attempt transition lost its state or lease fence.", "GEMINI_GCS_ATTEMPT_TRANSITION_CONFLICT");
      return mapRow(rows[0], key);
    },
    async listRecoveryAttempts({before=now().toISOString(),limit=100}={}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isFinite(Date.parse(before))) throw new Error("GCS mirror recovery query is invalid.");
      const params = new URLSearchParams({select,state:"in.(UPLOADING,OUTCOME_UNKNOWN,OBJECT_VERIFIED)",updated_at:"lt."+new Date(before).toISOString(),order:"updated_at.asc",limit:String(limit)});
      const rows = await request("?"+params.toString());
      if (!Array.isArray(rows)) throw new Error("GCS mirror recovery query returned an invalid result.");
      return rows.map(row=>mapRow(row,key));
    },
    async claimRecoveryAttempt({attemptId,expectedState}) {
      if (!UUID.test(String(attemptId || "")) || !ACTIVE.has(expectedState)) throw new Error("GCS mirror recovery claim is invalid.");
      const current=now(), leaseToken=randomUUID();
      const params=new URLSearchParams({id:"eq."+attemptId,state:"eq."+expectedState,or:"(lease_token.is.null,lease_expires_at.lt."+current.toISOString()+")",select:"id,lease_token"});
      const rows=await request("?"+params.toString(),{method:"PATCH",prefer:"return=representation",body:{lease_token:leaseToken,lease_expires_at:new Date(current.getTime()+15*60*1000).toISOString(),updated_at:current.toISOString()}});
      return Array.isArray(rows)&&rows.length===1&&rows[0].lease_token===leaseToken?leaseToken:null;
    },
    async releaseRecoveryAttempt({attemptId,leaseToken}) {
      if (!UUID.test(String(attemptId||""))||!UUID.test(String(leaseToken||""))) throw new Error("GCS mirror recovery lease is invalid.");
      const params=new URLSearchParams({id:"eq."+attemptId,lease_token:"eq."+leaseToken,select:"id"});
      const rows=await request("?"+params.toString(),{method:"PATCH",prefer:"return=representation",body:{lease_token:null,lease_expires_at:null,updated_at:now().toISOString()}});
      return Array.isArray(rows)&&rows.length===1;
    }
  });
}
