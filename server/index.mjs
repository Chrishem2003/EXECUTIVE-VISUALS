import { createServer } from "node:http";
import { generateCreativeDirection } from "./creative-director.mjs";
import { generateStoryboard } from "./storyboard-compiler.mjs";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, unlink, open, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, basename, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { openDatabase, audit, addJobEvent, getOwnedProject, getOwnedAsset, getProjectAccess, canWriteProject, getAccessibleAsset, json, parseJson } from "./db.mjs";
import { executeMediaJob, executableAvailable } from "./media.mjs";
import { createRealEsrganAdapter } from "./ai-upscale-engine.mjs";
import { validateWorkflowGraph, planWorkflowTarget } from "./workflow-validation.mjs";
import { validateTimelineDocument } from "./timeline-validation.mjs";
import { executeWorkflowRun } from "./workflow-executor.mjs";
import { claimNextJob, completeJob, recoverExpiredJobs, renewJobLease } from "./queue.mjs";
import { sanitizeCreativeWorkspaceDocument } from "./workspace-documents.mjs";
import { importResearchUrl } from "./research-import.mjs";
import { getProviderCatalog } from "./provider-registry.mjs";
import { ensureRemoteUsageTable, getRemoteUsagePolicy } from "./usage-guardrails.mjs";
import { createCloudTimelineApi } from "./cloud-timeline-api.mjs";
import { validateSrt, validateWebVtt } from "./caption-validation.mjs";
import { ensureTransformationPlanSchema, createTransformationPlan, approveTransformationPlan, listTransformationPlans, getTransformationPlan } from "./transformation-plans.mjs";
import { ensureAuthSecuritySchema, getLoginLockState, recordFailedLogin, clearLoginFailures } from "./auth-login-security.mjs";
import { createSupabaseAuth, SUPABASE_SESSION_COOKIE, SUPABASE_SESSION_MAX_AGE_SECONDS } from "./supabase-auth.mjs";
import { createGoogleDriveOAuth } from "./google-drive-oauth.mjs";
import { createGoogleDriveConnectionStore, createGoogleDriveOAuthStateStore } from "./google-drive-connection-store.mjs";
import { createGoogleDrivePrivateFileBridge } from "./google-drive-private-file-bridge.mjs";
import { createCloudAssetService } from "./cloud-asset-service.mjs";

const PORT = Number(process.env.API_PORT || process.env.PORT || 4179);
const HOST = process.env.API_HOST || "127.0.0.1";
const AUTH_MODE = process.env.AUTH_MODE || "local";
const supabaseAuth = AUTH_MODE === "supabase" && process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_SESSION_SECRET
  ? createSupabaseAuth({ url: process.env.SUPABASE_URL, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY, sessionSecret: process.env.SUPABASE_SESSION_SECRET })
  : null;
const googleDriveOAuthEnabled = process.env.GOOGLE_DRIVE_OAUTH_ENABLED === "true";
if (googleDriveOAuthEnabled && (AUTH_MODE !== "supabase" || !supabaseAuth)) {
  throw new Error("Google Drive OAuth requires fully configured verified Supabase authentication.");
}
const googleDriveConnectionStore = googleDriveOAuthEnabled ? createGoogleDriveConnectionStore() : null;
const googleDriveOAuthStateStore = googleDriveOAuthEnabled ? createGoogleDriveOAuthStateStore() : null;
const googleDriveOAuth = googleDriveOAuthEnabled ? createGoogleDriveOAuth({
  stateStore: googleDriveOAuthStateStore,
  connections: googleDriveConnectionStore
}) : null;
const googleDriveAssetService = googleDriveOAuthEnabled ? createCloudAssetService({
  maxBytes: Number(process.env.CLOUD_MEDIA_MAX_UPLOAD_BYTES || process.env.MAX_UPLOAD_BYTES || 250 * 1024 * 1024)
}) : null;
const googleDriveBridge = googleDriveOAuthEnabled ? createGoogleDrivePrivateFileBridge({
  getUserAccessToken: ({ ownerId }) => googleDriveOAuth.getAccessToken({ ownerId }),
  assets: googleDriveAssetService.assets,
  maxBytes: Number(process.env.CLOUD_MEDIA_MAX_UPLOAD_BYTES || process.env.MAX_UPLOAD_BYTES || 250 * 1024 * 1024),
  loadPrivateAsset: async ({ ownerId, projectId = null, assetId }) => {
    const asset = await googleDriveAssetService.assets.get({ ownerId, assetId });
    if ((asset.projectId || null) !== (projectId || null)) throw Object.assign(new Error("Private asset project scope does not match."), { code: "GOOGLE_DRIVE_ASSET_FORBIDDEN" });
    const signed = await googleDriveAssetService.assets.createSignedUrl({ ownerId, assetId, expiresIn: 60 });
    const signedUrl = new URL(signed.url), storageOrigin = new URL(process.env.SUPABASE_URL).origin;
    if (signedUrl.protocol !== "https:" || signedUrl.origin !== storageOrigin || signedUrl.username || signedUrl.password) {
      throw Object.assign(new Error("Private asset storage returned an unsafe signed URL."), { code: "GOOGLE_DRIVE_ASSET_INVALID" });
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(signedUrl, { redirect: "error", signal: controller.signal });
      if (!response.ok || !response.body) throw Object.assign(new Error("Private asset download failed."), { code: "GOOGLE_DRIVE_ASSET_DOWNLOAD_FAILED" });
      const declared = Number(response.headers.get("content-length") || asset.size);
      const maxBytes = Number(process.env.CLOUD_MEDIA_MAX_UPLOAD_BYTES || process.env.MAX_UPLOAD_BYTES || 250 * 1024 * 1024);
      if (declared !== asset.size || declared > maxBytes) throw Object.assign(new Error("Private asset download size is invalid."), { code: "GOOGLE_DRIVE_ASSET_INVALID" });
      const reader = response.body.getReader(), chunks = []; let total = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          total += part.value.byteLength;
          if (total > maxBytes) { await reader.cancel().catch(() => {}); throw Object.assign(new Error("Private asset exceeds the export limit."), { code: "GOOGLE_DRIVE_ASSET_INVALID" }); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (bytes.byteLength !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        throw Object.assign(new Error("Private asset integrity verification failed."), { code: "GOOGLE_DRIVE_ASSET_INVALID" });
      }
      return { asset, bytes };
    } finally { clearTimeout(timer); }
  }
}) : null;
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT || join(DATA_DIR, "media"));
const WEB_ROOT = resolve(process.env.WEB_ROOT || "./dist");
const DB_FILE = resolve(process.env.DB_FILE || join(DATA_DIR, "executive-visuals.sqlite"));
const REQUIRE_PERSISTENT_DATA_DIR = process.env.REQUIRE_PERSISTENT_DATA_DIR === "true";
const isWithinDataDir = path => path === DATA_DIR || path.startsWith(DATA_DIR + sep);
if (REQUIRE_PERSISTENT_DATA_DIR && (!existsSync(DATA_DIR) || !isWithinDataDir(DB_FILE) || !isWithinDataDir(MEDIA_ROOT))) {
  throw new Error("Persistent storage is required. Mount the configured data volume before starting the service.");
}
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 250 * 1024 * 1024);
const SESSION_DAYS = 30;
const ALLOWED_MEDIA = new Set([
  "image/jpeg","image/png","image/webp","image/gif",
  "video/mp4","video/webm","video/quicktime","video/x-matroska",
  "audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/ogg",
  "application/pdf","text/plain","text/vtt","application/json"
]);
const EXTENSIONS = {
  "image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif",
  "video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","video/x-matroska":"mkv",
  "audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/ogg":"ogg",
  "application/pdf":"pdf","text/plain":"txt","text/vtt":"vtt","application/json":"json"
};
const MEDIA_JOBS = new Set(["media.probe","media.thumbnail","media.transcode","media.audio_extract","media.audio-clean","media.proxy","media.denoise","media.color","media.resize","media.interpolate","media.upscale","media.ai-upscale","timeline.render"]);
const db = openDatabase(DB_FILE);
ensureTransformationPlanSchema(db);
ensureAuthSecuritySchema(db);
const aiUpscaleAdapter = createRealEsrganAdapter();
const cloudTimelineApiEnabled = process.env.CLOUD_TIMELINE_API_ENABLED === "true";
if (cloudTimelineApiEnabled && AUTH_MODE !== "supabase") throw new Error("Cloud timeline API requires verified Supabase authentication.");
const cloudTimelineApi = cloudTimelineApiEnabled ? createCloudTimelineApi({maxUploadBytes:Number(process.env.CLOUD_MEDIA_MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES)}) : null;
if (cloudTimelineApi) await cloudTimelineApi.checkReadiness();
const activeProcesses = new Map();
const WORKER_ID = randomUUID();
const rateBuckets = new Map();
const AUTH_RATE_LIMIT = Math.max(1, Math.min(1000, Number(process.env.AUTH_RATE_LIMIT) || 10));
function rateAllowed(key,limit,windowMs){const time=Date.now();const old=rateBuckets.get(key);if(!old||time-old.start>=windowMs){rateBuckets.set(key,{start:time,count:1});return true;}old.count++;return old.count<=limit;}
await mkdir(join(MEDIA_ROOT,"uploads"), { recursive:true });
await mkdir(join(MEDIA_ROOT,"derived"), { recursive:true });

const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const stableJson = value => Array.isArray(value) ? "["+value.map(stableJson).join(",")+"]" : value && typeof value==="object" ? "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stableJson(value[key])).join(",")+"}" : JSON.stringify(value);
function timelineVersionHash(timeline,otio=null){return hash(stableJson({timeline,otio:otio??null}));}
function insertTimelineVersion(db,{timelineId,ownerId,projectId,revision,parentVersionId=null,restoredFromVersionId=null,name,summary="",timeline,otio=null,createdBy}){
 const id=randomUUID(),timelineJson=json(timeline),otioJson=otio?json(otio):null,contentHash=timelineVersionHash(timeline,otio);
 db.prepare("INSERT INTO timeline_versions(id,timeline_id,owner_id,project_id,revision,parent_version_id,restored_from_version_id,name,summary,content_hash,timeline_json,otio_json,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(id,timelineId,ownerId,projectId,revision,parentVersionId,restoredFromVersionId,name,String(summary||"").slice(0,500),contentHash,timelineJson,otioJson,createdBy);
 return{id,timelineId,ownerId,projectId,revision,parentVersionId,restoredFromVersionId,name,summary:String(summary||"").slice(0,500),contentHash,createdBy};
}
function ensureTimelineBaseline(db,record){
 const existing=db.prepare("SELECT id FROM timeline_versions WHERE timeline_id=? AND revision=?").get(record.id,record.revision);
 if(existing)return existing.id;
 return insertTimelineVersion(db,{
  timelineId:record.id,ownerId:record.owner_id,projectId:record.project_id,revision:record.revision,
  name:record.name,summary:"Baseline captured before version history was enabled.",
  timeline:parseJson(record.timeline_json),otio:record.otio_json?parseJson(record.otio_json):null,createdBy:record.owner_id
 }).id;
}
function mapTimelineVersion(row,includeSnapshot=false){
 const version={id:row.id,timelineId:row.timeline_id,ownerId:row.owner_id,projectId:row.project_id,revision:row.revision,parentVersionId:row.parent_version_id,restoredFromVersionId:row.restored_from_version_id,name:row.name,summary:row.summary,contentHash:row.content_hash,createdBy:row.created_by,createdAt:row.created_at};
 if(includeSnapshot){version.document=parseJson(row.timeline_json);version.otio=row.otio_json?parseJson(row.otio_json):null;if(version.contentHash&&timelineVersionHash(version.document,version.otio)!==version.contentHash)throw Object.assign(new Error("Timeline version snapshot failed its integrity check."),{code:"TIMELINE_VERSION_CORRUPT"});}
 return version;
}
const safeName = value => basename(String(value || "upload")).replace(/[\u0000-\u001f\u007f]/g,"").replace(/[^\p{L}\p{N}._() -]/gu,"_").slice(0,180) || "upload";
const SECURITY_HEADERS = {
  "x-content-type-options":"nosniff",
  "x-frame-options":"DENY",
  "referrer-policy":"strict-origin-when-cross-origin",
  "cross-origin-opener-policy":"same-origin",
  "cross-origin-resource-policy":"same-origin",
  "permissions-policy":"camera=(), microphone=(), geolocation=()"
};
const HTML_CSP = "default-src 'self'; script-src 'self' https://apis.google.com https://www.gstatic.com; frame-src 'self' https://drive.google.com https://docs.google.com; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://content.googleapis.com; img-src 'self' data: blob: https://drive.google.com https://lh3.googleusercontent.com https://*.googleusercontent.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const send = (res,status,body,headers={}) => { res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...SECURITY_HEADERS,...headers});res.end(JSON.stringify(body)); };
const fail = (res,status,code,message) => send(res,status,{error:{code,message}});
const readJson = async (req,limit=1024*1024) => {
  const chunks=[];let size=0;
  for await (const chunk of req) { size+=chunk.length;if(size>limit)throw Object.assign(new Error("Request body too large."),{status:413,code:"BODY_TOO_LARGE"});chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."),{status:400,code:"INVALID_JSON"}); }
};
const cookieValue = (req,name) => {
  const raw=req.headers.cookie||"";
  for(const part of raw.split(";")){const [key,...rest]=part.trim().split("=");if(key===name)return decodeURIComponent(rest.join("="));}
  return "";
};
const setCookie = (res,token,maxAge) => {
  const secure=process.env.COOKIE_SECURE==="true"||process.env.NODE_ENV==="production" ? "; Secure" : "";
  res.setHeader("set-cookie",`ev_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
};
const setSupabaseCookie = (res,token,maxAge) => {
  const secure=process.env.COOKIE_SECURE==="true"||process.env.NODE_ENV==="production" ? "; Secure" : "";
  res.setHeader("set-cookie",`${SUPABASE_SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
};
const requestAccessTokens = new WeakMap();
function createLocalSession(userId) {
  const token=randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .run(hash(token),userId,new Date(Date.now()+SESSION_DAYS*86400000).toISOString());
  return token;
}
async function authenticate(req,res) {
  if (AUTH_MODE === "supabase") {
    if(!supabaseAuth)return null;
    const session=await supabaseAuth.getUser(cookieValue(req,SUPABASE_SESSION_COOKIE));
    if(!session)return null;
    if(typeof session.accessToken === "string" && session.accessToken)requestAccessTokens.set(req,session.accessToken);
    if(session.cookie)setSupabaseCookie(res,session.cookie,session.maxAge||SUPABASE_SESSION_MAX_AGE_SECONDS);
    const user=session.user;
    db.prepare("INSERT INTO users(id,email,auth_source) VALUES(?,?, 'supabase') ON CONFLICT(id) DO UPDATE SET email=excluded.email")
      .run(user.id,user.email||user.id+"@supabase.invalid");
    return {id:user.id,email:user.email||""};
  }
  const token=cookieValue(req,"ev_session");
  if(!token)return null;
  const row=db.prepare("SELECT u.id,u.email,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").get(hash(token));
  if(!row)return null;
  if(Date.parse(row.expires_at)<=Date.now()){db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));return null;}
  return {id:row.id,email:row.email};
}
function originHeaders(req) {
  const origin=req.headers.origin;
  if(!origin)return {};
  const allowed=(process.env.CORS_ORIGINS||"http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173")
    .split(",").map(x=>x.trim()).filter(Boolean);
  let parsed;
  try { parsed=new URL(origin); } catch { return null; }
  if(!allowed.includes(origin) && parsed.host!==req.headers.host)return null;
  return {"access-control-allow-origin":origin,"access-control-allow-credentials":"true","vary":"Origin"};
}
function recordJob(dbRow) {
  return {
    id:dbRow.id,projectId:dbRow.project_id,jobType:dbRow.job_type,status:dbRow.status,
    progress:dbRow.progress,input:parseJson(dbRow.input_json),output:parseJson(dbRow.output_json,null),
    error:parseJson(dbRow.error_json,null),attempts:dbRow.attempt_count,availableAt:dbRow.available_at,
    createdAt:dbRow.created_at,updatedAt:dbRow.updated_at,startedAt:dbRow.started_at,completedAt:dbRow.completed_at
  };
}
function accessibleJob(ownerId,id,write=false) {
  const job=db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  if(!job)return null;
  if(!job.project_id)return job.owner_id===ownerId?job:null;
  const access=getProjectAccess(db,ownerId,job.project_id);
  if(!access||write&&!["owner","editor"].includes(access.access_role))return null;
  return job;
}

function validFileSignature(type,header){
  if(type==="image/png")return header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(type==="image/jpeg")return header[0]===0xff&&header[1]===0xd8&&header[2]===0xff;
  if(type==="image/webp")return header.subarray(0,4).toString()==="RIFF"&&header.subarray(8,12).toString()==="WEBP";
  if(type==="image/gif")return ["GIF87a","GIF89a"].includes(header.subarray(0,6).toString());
  if(["video/mp4","video/quicktime","audio/mp4"].includes(type))return header.subarray(4,8).toString()==="ftyp";
  if(["video/webm","video/x-matroska"].includes(type))return header.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if(type==="audio/mpeg")return header.subarray(0,3).toString()==="ID3"||(header[0]===0xff&&(header[1]&0xe0)===0xe0);
  if(type==="audio/wav"||type==="audio/x-wav")return header.subarray(0,4).toString()==="RIFF"&&header.subarray(8,12).toString()==="WAVE";
  if(type==="audio/ogg")return header.subarray(0,4).toString()==="OggS";
  if(type==="application/pdf")return header.subarray(0,5).toString()==="%PDF-";
  if(type==="text/plain"||type==="text/vtt")return !header.includes(0);
  if(type==="application/json")return true;
  return false;
}
async function storeUpload(req,user,projectId) {
  const mediaType=String(req.headers["content-type"]||"application/octet-stream").split(";")[0].toLowerCase();
  if(!ALLOWED_MEDIA.has(mediaType))throw Object.assign(new Error("Unsupported media type."),{status:415,code:"UNSUPPORTED_MEDIA_TYPE"});
  if(projectId&&!canWriteProject(db,user.id,projectId))throw Object.assign(new Error("Project not found or you do not have editor access."),{status:404,code:"PROJECT_NOT_FOUND"});
  const declaredSize=Number(req.headers["content-length"]||0);
  if(declaredSize>MAX_UPLOAD_BYTES)throw Object.assign(new Error("Upload exceeds the configured size limit."),{status:413,code:"UPLOAD_TOO_LARGE"});
  let decodedName="upload";
  try{decodedName=decodeURIComponent(String(req.headers["x-file-name"]||"upload"));}
  catch{throw Object.assign(new Error("File name header is malformed."),{status:400,code:"INVALID_FILE_NAME"});}
  const originalName=safeName(decodedName);
  const id=randomUUID(), ext=EXTENSIONS[mediaType]||"bin", relative="uploads/"+id+"."+ext, absolute=join(MEDIA_ROOT,relative);
  const digest=createHash("sha256");let size=0;
  const meter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>MAX_UPLOAD_BYTES){callback(Object.assign(new Error("Upload exceeds the configured size limit."),{status:413,code:"UPLOAD_TOO_LARGE"}));return;}digest.update(chunk);callback(null,chunk);}});
  try { await pipeline(req,meter,createWriteStream(absolute,{flags:"wx"})); }
  catch(error){await unlink(absolute).catch(()=>{});throw error;}
  if(size===0){await unlink(absolute).catch(()=>{});throw Object.assign(new Error("Empty uploads are not accepted."),{status:400,code:"EMPTY_UPLOAD"});}
  const handle=await open(absolute,"r");
  const header=Buffer.alloc(32);
  const read=await handle.read(header,0,32,0);
  await handle.close();
  if(!validFileSignature(mediaType,header.subarray(0,read.bytesRead))){
    await unlink(absolute).catch(()=>{});
    throw Object.assign(new Error("File signature does not match the declared media type."),{status:415,code:"MEDIA_SIGNATURE_MISMATCH"});
  }
  const sha256=digest.digest("hex");
  const extension=extname(originalName).toLowerCase();
  const metadata=(extension===".srt"&&(mediaType==="text/plain"||mediaType==="application/x-subrip"))?{captionValidation:validateSrt(await readFile(absolute,"utf8"))}:extension===".vtt"&&mediaType==="text/vtt"?{captionValidation:validateWebVtt(await readFile(absolute,"utf8"))}:{};
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id,user.id,projectId||null,originalName,mediaType,size,sha256,relative,json(metadata));
  audit(db,user.id,"asset.uploaded","asset",id,{name:originalName,mediaType,size,sha256},projectId||null);
  return {id,projectId:projectId||null,name:originalName,mediaType,size,sha256,createdAt:now()};
}
async function processNextJob() {
  recoverExpiredJobs(db);
  const current=claimNextJob(db,WORKER_ID,90000,now(),["workflow.execute",...MEDIA_JOBS]);
  if(!current)return;
  const job=current;
  addJobEvent(db,job.id,job.owner_id,"job.started",{attempt:current.attempt_count,workerLease:true});
  let leaseLost=false;
  const heartbeat=setInterval(()=>{
    if(!renewJobLease(db,job.id,WORKER_ID)){
      leaseLost=true;
      const active=activeProcesses.get(job.id);
      if(active&&!active.killed)active.kill("SIGTERM");
    }
  },15000);
  heartbeat.unref();
  try {
    const execute=current.job_type==="workflow.execute"?executeWorkflowRun:executeMediaJob;
    const result=await execute({
      db,job:current,mediaRoot:MEDIA_ROOT,activeProcesses,
      onProgress:value=>{
        const changed=db.prepare("UPDATE jobs SET progress=?,updated_at=? WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?")
          .run(value,now(),job.id,WORKER_ID,now());
        if(changed.changes===1)addJobEvent(db,job.id,job.owner_id,"job.progress",{progress:value});
      }
    });
    const latest=db.prepare("SELECT status,lease_owner,lease_expires_at FROM jobs WHERE id=?").get(job.id);
    if(latest?.status==="cancelled"||leaseLost||latest?.lease_owner!==WORKER_ID||!latest?.lease_expires_at||Date.parse(latest.lease_expires_at)<=Date.now())return;
    if(current.job_type==="media.probe"&&result.metadata){
      const input=parseJson(current.input_json),source=getAccessibleAsset(db,current.owner_id,String(input.sourceAssetId||""),true);
      if(source){const existing=parseJson(source.metadata_json,{});db.prepare("UPDATE assets SET metadata_json=? WHERE id=?").run(json({...existing,probe:result.metadata}),source.id);}
    }
    if(completeJob(db,job.id,WORKER_ID,result,now())){
      audit(db,job.owner_id,"job.succeeded","job",job.id,{jobType:job.job_type},job.project_id);
    }
  } catch(error) {
    const latest=db.prepare("SELECT status,attempt_count,max_attempts,lease_owner,lease_expires_at FROM jobs WHERE id=?").get(job.id);
    if(latest?.status==="cancelled"||leaseLost||latest?.lease_owner!==WORKER_ID||!latest?.lease_expires_at||Date.parse(latest.lease_expires_at)<=Date.now())return;
    const workflowRun=current.job_type==="workflow.execute"
      ?db.prepare("SELECT status FROM workflow_runs WHERE job_id=?").get(job.id)
      :null;
    const workflowBlocked=workflowRun?.status==="blocked";
    const retryable=["MEDIA_TIMEOUT","MEDIA_PROCESS_FAILED"].includes(error.code);
    const retry=retryable&&!workflowBlocked&&latest.attempt_count<latest.max_attempts;
    const status=workflowBlocked?"blocked":retry?"queued":"failed";
    const delayMs=retry?Math.min(60000,1000*Math.pow(2,Math.max(0,latest.attempt_count-1))):0;
    const availableAt=retry?new Date(Date.now()+delayMs).toISOString():null;
    const details={code:error.code||"MEDIA_JOB_FAILED",message:String(error.message||"Media job failed.").slice(0,1000),retryable,retryDelayMs:delayMs};
    const changed=db.prepare("UPDATE jobs SET status=?,error_json=?,updated_at=?,completed_at=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?")
      .run(status,json(details),now(),retry?null:now(),availableAt,job.id,WORKER_ID,now());
    if(changed.changes===1)addJobEvent(db,job.id,job.owner_id,workflowBlocked?"job.blocked":retry?"job.retry_scheduled":"job.failed",details);
  } finally {
    clearInterval(heartbeat);
  }
}
let workerBusy=false;
const workerTimer=process.env.DISABLE_WORKER==="true"?null:setInterval(async()=>{if(workerBusy)return;workerBusy=true;try{await processNextJob();}catch(error){process.stderr.write("Worker cycle failed: "+String(error.message)+"\\n");}finally{workerBusy=false;}},500);
workerTimer?.unref();

export function createAppServer() {
  return createServer(async(req,res)=>{
    const cors=originHeaders(req);
    if(cors===null){fail(res,403,"ORIGIN_DENIED","Request origin is not allowed.");return;}
    if(req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-methods":"GET,POST,PUT,DELETE,OPTIONS","access-control-allow-headers":"content-type,authorization,x-file-name,x-project-id,idempotency-key","access-control-max-age":"600",...cors});res.end();return;}
    const url=new URL(req.url||"/","http://localhost");
    const path=url.pathname;
    const ratePath=path.startsWith("/api/auth/")?"/auth":path.startsWith("/api/integrations/google-drive/")?"/google-drive-oauth":(path==="/api/assets"||path==="/api/cloud/assets")&&req.method==="POST"?"/upload":path.endsWith("/research/import")&&req.method==="POST"?"/research":path==="/api/creative/director"&&req.method==="POST"?"/creative-director":path==="/api/creative/storyboard"&&req.method==="POST"?"/creative-storyboard":path==="/api/admin/ai-upscale/self-test"&&req.method==="POST"?"/ai-upscale-self-test":"";
    if(ratePath){const key=(req.socket.remoteAddress||"unknown")+ratePath;const limit=ratePath==="/auth"?AUTH_RATE_LIMIT:ratePath==="/research"?10:ratePath==="/creative-director"?5:ratePath==="/creative-storyboard"?5:ratePath==="/ai-upscale-self-test"?2:ratePath==="/google-drive-oauth"?20:30;if(!rateAllowed(key,limit,60000)){fail(res,429,"RATE_LIMITED","Too many requests. Wait before trying again.");return;}}
    try {
      if(!path.startsWith("/api/")&&req.method==="GET"){
        const decoded=decodeURIComponent(path);
        let file=resolve(WEB_ROOT,"."+decoded);
        const webPrefix=WEB_ROOT.endsWith(sep)?WEB_ROOT:WEB_ROOT+sep;
        if(!file.startsWith(webPrefix)&&file!==join(WEB_ROOT,"index.html"))file=join(WEB_ROOT,"index.html");
        if(!existsSync(file)||!statSync(file).isFile())file=join(WEB_ROOT,"index.html");
        if(existsSync(file)&&statSync(file).isFile()){
          const ext=extname(file).toLowerCase();
          const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".webp":"image/webp",".woff2":"font/woff2",".json":"application/json"};
          res.writeHead(200,{"content-type":types[ext]||"application/octet-stream","cache-control":ext===".html"?"no-cache":"public, max-age=31536000, immutable",...SECURITY_HEADERS,...(ext===".html"?{"content-security-policy":HTML_CSP}:{}),...cors});
          createReadStream(file).pipe(res);return;
        }
      }
      if(path==="/api/health"&&req.method==="GET"){
        send(res,200,{status:"ok",storage:"local-disk",database:"sqlite",authMode:AUTH_MODE,authReady:AUTH_MODE==="local"||Boolean(supabaseAuth),media:{ffmpeg:executableAvailable("ffmpeg"),ffprobe:executableAvailable("ffprobe")},imageGateway:{enabled:process.env.IMAGE_GATEWAY_ENABLED==="true",configured:(()=>{try{const url=new URL(process.env.IMAGE_GATEWAY_URL||"");const local=["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname.toLowerCase());return Boolean(process.env.IMAGE_GATEWAY_MODEL&&(local||process.env.IMAGE_GATEWAY_ALLOW_REMOTE==="true"));}catch{return false;}})()},textGateway:{enabled:process.env.AI_GATEWAY_ENABLED==="true",configured:(()=>{try{const url=new URL(process.env.AI_GATEWAY_URL||"");const local=["localhost","127.0.0.1","::1"].includes(url.hostname.toLowerCase());return Boolean(process.env.AI_GATEWAY_MODEL&&(local||process.env.AI_GATEWAY_ALLOW_REMOTE==="true"));}catch{return false;}})()},authMode:AUTH_MODE,googleDriveOAuth:{enabled:googleDriveOAuthEnabled,configured:Boolean(googleDriveOAuth)},version:"0.1.0"},cors);return;
      }
      if(AUTH_MODE==="supabase"&&path==="/api/auth/recovery/session"&&req.method==="POST"){
        if(!supabaseAuth){fail(res,503,"SUPABASE_AUTH_NOT_CONFIGURED","The secure identity service is not fully configured.");return;}
        const body=await readJson(req);
        try{
          const session=await supabaseAuth.adoptRecoverySession(body.accessToken,body.refreshToken);
          setSupabaseCookie(res,session.cookie,session.maxAge);
          send(res,200,{user:session.user,recovery:true},cors);return;
        }catch(error){const status=error.code==="SUPABASE_AUTH_UNAVAILABLE"||error.code==="SUPABASE_AUTH_TIMEOUT"?503:400;fail(res,status,error.code||"SUPABASE_RECOVERY_INVALID",error.message||"The recovery link could not be verified.");return;}
      }
      if(AUTH_MODE==="supabase"&&path==="/api/auth/password"&&req.method==="POST"){
        if(!supabaseAuth){fail(res,503,"SUPABASE_AUTH_NOT_CONFIGURED","The secure identity service is not fully configured.");return;}
        const body=await readJson(req);
        try{
          const session=await supabaseAuth.updatePassword(cookieValue(req,SUPABASE_SESSION_COOKIE),body.password);
          setSupabaseCookie(res,session.cookie,session.maxAge);
          send(res,200,{user:session.user,authMode:"supabase"},cors);return;
        }catch(error){const status=error.code==="INVALID_PASSWORD"?400:error.code==="SUPABASE_RECOVERY_INVALID"?401:503;fail(res,status,error.code||"SUPABASE_PASSWORD_UPDATE_FAILED",error.message||"The password could not be updated.");return;}
      }
      if(AUTH_MODE==="supabase"&&path==="/api/auth/recover"&&req.method==="POST"){
        if(!supabaseAuth){fail(res,503,"SUPABASE_AUTH_NOT_CONFIGURED","The secure identity service is not fully configured.");return;}
        const body=await readJson(req);
        try{await supabaseAuth.requestPasswordRecovery(body.email);send(res,200,{ok:true},cors);return;}
        catch(error){fail(res,error.code==="INVALID_CREDENTIALS"?400:503,error.code||"SUPABASE_AUTH_UNAVAILABLE",error.message||"Password recovery could not be completed.");return;}
      }
      if(AUTH_MODE==="supabase"&&path==="/api/auth/register"&&req.method==="POST"){
        if(!supabaseAuth){fail(res,503,"SUPABASE_AUTH_NOT_CONFIGURED","The secure identity service is not fully configured.");return;}
        const body=await readJson(req);
        try{
          const result=await supabaseAuth.signUp(body.email,body.password);
          if(result.cookie)setSupabaseCookie(res,result.cookie,result.maxAge);
          send(res,result.confirmationRequired?202:201,{user:result.user,authMode:"supabase",confirmationRequired:Boolean(result.confirmationRequired)},cors);return;
        }catch(error){fail(res,error.code==="INVALID_CREDENTIALS"?400:error.code==="SIGNUP_REJECTED"?400:503,error.code||"SUPABASE_AUTH_UNAVAILABLE",error.message||"Registration could not be completed.");return;}
      }
      if(path==="/api/auth/register"&&req.method==="POST"){
        if(AUTH_MODE!=="local"||process.env.NODE_ENV==="production"){fail(res,403,"REGISTRATION_DISABLED","Local account registration is disabled in this environment.");return;}
        const body=await readJson(req);const email=String(body.email||"").trim().toLowerCase();const password=String(body.password||"");
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12){fail(res,400,"INVALID_CREDENTIALS","Enter a valid email and a password of at least 12 characters.");return;}
        const id=randomUUID(),salt=randomBytes(16).toString("hex"),passwordHash=scryptSync(password,salt,64).toString("hex");
        try{db.prepare("INSERT INTO users(id,email,password_hash,password_salt) VALUES(?,?,?,?)").run(id,email,passwordHash,salt);}
        catch{fail(res,409,"ACCOUNT_EXISTS","An account with this email already exists.");return;}
        const token=createLocalSession(id);setCookie(res,token,SESSION_DAYS*86400);audit(db,id,"account.created","user",id,{authMode:"local"});
        send(res,201,{user:{id,email},authMode:"local"},cors);return;
      }
      if(AUTH_MODE==="supabase"&&path==="/api/auth/login"&&req.method==="POST"){
        if(!supabaseAuth){fail(res,503,"SUPABASE_AUTH_NOT_CONFIGURED","The secure identity service is not fully configured.");return;}
        const body=await readJson(req),email=String(body.email||"").trim().toLowerCase();
        const lockState=getLoginLockState(db,email);
        if(lockState.locked){const retrySeconds=Math.max(1,Math.ceil(lockState.retryAfterMs/1000));send(res,423,{error:{code:"ACCOUNT_TEMPORARILY_LOCKED",message:"Sign-in is temporarily locked. Try again after the displayed wait."},retryAfterSeconds:retrySeconds},{"retry-after":String(retrySeconds),...cors});return;}
        try{
          const session=await supabaseAuth.signIn(email,body.password);
          clearLoginFailures(db,email);setSupabaseCookie(res,session.cookie,session.maxAge);
          send(res,200,{user:session.user,authMode:"supabase"},cors);return;
        }catch(error){
          if(error.code==="INVALID_CREDENTIALS"){
            const failure=recordFailedLogin(db,email);
            if(failure.locked){const retrySeconds=Math.max(1,Math.ceil(failure.retryAfterMs/1000));send(res,423,{error:{code:"ACCOUNT_TEMPORARILY_LOCKED",message:"Sign-in is temporarily locked after repeated failures. Try again after the displayed wait."},retryAfterSeconds:retrySeconds},{"retry-after":String(retrySeconds),...cors});return;}
            fail(res,401,"INVALID_CREDENTIALS","Email or password is incorrect.");return;
          }
          fail(res,503,error.code||"SUPABASE_AUTH_UNAVAILABLE",error.message||"Sign-in could not be completed.");return;
        }
      }
      if(path==="/api/auth/login"&&req.method==="POST"){
        if(AUTH_MODE!=="local"){fail(res,403,"USE_EXTERNAL_AUTH","Sign in through the configured identity provider.");return;}
        const body=await readJson(req);const email=String(body.email||"").trim().toLowerCase();const password=String(body.password||"");
        if(password.length===0||password.length>256){fail(res,401,"INVALID_CREDENTIALS","Email or password is incorrect.");return;}
        const lockState=getLoginLockState(db,email);
        if(lockState.locked){const retrySeconds=Math.max(1,Math.ceil(lockState.retryAfterMs/1000));send(res,423,{error:{code:"ACCOUNT_TEMPORARILY_LOCKED",message:"Sign-in is temporarily locked. Try again after the displayed wait."},retryAfterSeconds:retrySeconds},{"retry-after":String(retrySeconds),...cors});return;}
        const user=db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email);
        const candidate=user?scryptSync(password,user.password_salt,64).toString("hex"):"";
        const valid=!!user&&candidate.length===user.password_hash.length&&timingSafeEqual(Buffer.from(candidate,"hex"),Buffer.from(user.password_hash,"hex"));
        if(!valid){
          const failure=recordFailedLogin(db,email);
          if(failure.locked){const retrySeconds=Math.max(1,Math.ceil(failure.retryAfterMs/1000));send(res,423,{error:{code:"ACCOUNT_TEMPORARILY_LOCKED",message:"Sign-in is temporarily locked after repeated failures. Try again after the displayed wait."},retryAfterSeconds:retrySeconds},{"retry-after":String(retrySeconds),...cors});return;}
          fail(res,401,"INVALID_CREDENTIALS","Email or password is incorrect.");return;
        }
        clearLoginFailures(db,email);
        const token=createLocalSession(user.id);setCookie(res,token,SESSION_DAYS*86400);
        send(res,200,{user:{id:user.id,email:user.email},authMode:"local"},cors);return;
      }
      if(path==="/api/auth/logout"&&req.method==="POST"){
        if(AUTH_MODE==="supabase"){
          if(supabaseAuth)await supabaseAuth.signOut(cookieValue(req,SUPABASE_SESSION_COOKIE));
          setSupabaseCookie(res,"",0);send(res,200,{ok:true},cors);return;
        }
        const token=cookieValue(req,"ev_session");if(token)db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
        setCookie(res,"",0);send(res,200,{ok:true},cors);return;
      }
      if(path==="/api/integrations/google-drive/callback"&&req.method==="GET"){
        if(!googleDriveOAuth){fail(res,503,"GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED","Google Drive connection is not enabled.");return;}
        if(url.searchParams.has("error")){
          res.writeHead(303,{"location":"/?googleDrive=error","cache-control":"no-store",...SECURITY_HEADERS});res.end();return;
        }
        try{
          await googleDriveOAuth.complete({state:url.searchParams.get("state"),code:url.searchParams.get("code")});
          res.writeHead(303,{"location":"/?googleDrive=connected","cache-control":"no-store",...SECURITY_HEADERS});res.end();return;
        }catch(error){
          const status=error.code==="GOOGLE_OAUTH_UNAVAILABLE"||error.code==="GOOGLE_OAUTH_TIMEOUT"||error.code==="GOOGLE_OAUTH_IDENTITY_UNAVAILABLE"?503:400;
          process.stderr.write("Google Drive OAuth callback failed: "+String(error.code||"GOOGLE_OAUTH_CALLBACK_FAILED")+"\\n");
          res.writeHead(303,{"location":"/?googleDrive=error","cache-control":"no-store",...SECURITY_HEADERS});res.end();return;
        }
      }
      const user=await authenticate(req,res);
      if(!user){fail(res,401,"AUTH_REQUIRED","Sign in to access this workspace.");return;}
      if(path==="/api/integrations/google-drive/status"&&req.method==="GET"){
        if(!googleDriveOAuth||!googleDriveConnectionStore){fail(res,503,"GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED","Google Drive connection is not enabled.");return;}
        try{
          const connection=await googleDriveConnectionStore.get(user.id);
          send(res,200,{connected:Boolean(connection),email:connection?.email||null,grantedScopes:connection?.grantedScopes||[]},cors);return;
        }catch(error){fail(res,503,error.code||"GOOGLE_CONNECTION_STORE_UNAVAILABLE","Google Drive connection status is temporarily unavailable.");return;}
      }
      if(path==="/api/integrations/google-drive/connect"&&req.method==="POST"){
        if(!googleDriveOAuth){fail(res,503,"GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED","Google Drive connection is not enabled.");return;}
        try{send(res,200,await googleDriveOAuth.begin({ownerId:user.id}),cors);return;}
        catch(error){fail(res,503,error.code||"GOOGLE_OAUTH_UNAVAILABLE","Google Drive authorization could not be started.");return;}
      }
      if(path==="/api/integrations/google-drive/picker-token"&&req.method==="POST"){
        if(!googleDriveOAuth){fail(res,503,"GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED","Google Drive connection is not enabled.");return;}
        const developerKey=String(process.env.GOOGLE_PICKER_API_KEY||"").trim();
        const appId=String(process.env.GOOGLE_CLOUD_PROJECT_NUMBER||"").trim();
        if(!developerKey||developerKey.length>512||!/^\\d{6,24}$/.test(appId)){fail(res,503,"GOOGLE_PICKER_NOT_CONFIGURED","Google Picker API key and numeric Cloud project number are not configured.");return;}
        try{
          const accessToken=await googleDriveOAuth.getAccessToken({ownerId:user.id});
          send(res,200,{accessToken,developerKey,appId,expiresInSeconds:300},cors);return;
        }catch(error){fail(res,401,error.code||"GOOGLE_OAUTH_NOT_CONNECTED","Connect Google Drive before opening the file picker.");return;}
      }
      if(path==="/api/integrations/google-drive/disconnect"&&req.method==="POST"){
        if(!googleDriveOAuth){fail(res,503,"GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED","Google Drive connection is not enabled.");return;}
        try{
          const result=await googleDriveOAuth.disconnect({ownerId:user.id});
          audit(db,user.id,"integration.google_drive.disconnected","integration","google-drive",{revoked:result.revoked});
          send(res,200,result,cors);return;
        }catch(error){fail(res,503,error.code||"GOOGLE_OAUTH_DISCONNECT_FAILED","Google Drive could not be disconnected cleanly.");return;}
      }
      if(path==="/api/integrations/google-drive/import"&&req.method==="POST"){
        if(!googleDriveBridge){fail(res,503,"GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED","Google Drive file import is not enabled.");return;}
        const body=await readJson(req);
        try{
          const result=await googleDriveBridge.importFile({ownerId:user.id,projectId:body.projectId||null,fileId:body.fileId});
          audit(db,user.id,"integration.google_drive.file_imported","asset",result.asset.id,{providerFileId:result.sourceFileId,projectId:body.projectId||null});
          send(res,201,{asset:result.asset,source:result.source},cors);return;
        }catch(error){const status=error.code==="GOOGLE_DRIVE_AUTH_REQUIRED"?401:error.code==="GOOGLE_DRIVE_FILE_UNSUPPORTED"||error.code==="GOOGLE_DRIVE_FILE_ID_INVALID"?400:error.code==="GOOGLE_DRIVE_ACCESS_DENIED"||error.code==="GOOGLE_DRIVE_ASSET_FORBIDDEN"?403:502;fail(res,status,error.code||"GOOGLE_DRIVE_IMPORT_FAILED",error.message||"Google Drive file import failed.");return;}
      }
      if(path==="/api/integrations/google-drive/export"&&req.method==="POST"){
        if(!googleDriveBridge){fail(res,503,"GOOGLE_DRIVE_OAUTH_NOT_CONFIGURED","Google Drive file export is not enabled.");return;}
        const body=await readJson(req);
        try{
          const result=await googleDriveBridge.uploadPrivateAsset({ownerId:user.id,projectId:body.projectId||null,assetId:body.assetId,parentFolderId:body.parentFolderId||null});
          audit(db,user.id,"integration.google_drive.file_exported","asset",body.assetId,{driveFileId:result.id,projectId:body.projectId||null});
          send(res,201,{file:result},cors);return;
        }catch(error){const status=error.code==="GOOGLE_DRIVE_AUTH_REQUIRED"?401:error.code==="GOOGLE_DRIVE_ASSET_FORBIDDEN"?403:error.code==="GOOGLE_DRIVE_EXPORT_SCOPE_INVALID"?400:502;fail(res,status,error.code||"GOOGLE_DRIVE_EXPORT_FAILED",error.message||"Google Drive file export failed.");return;}
      }
      if(path==="/api/me"&&req.method==="GET"){send(res,200,{user,authMode:AUTH_MODE},cors);return;}
      if(path==="/api/creative/storyboard"&&req.method==="POST"){
        const body=await readJson(req,48*1024);
        const projectId=String(body?.projectId||"").trim()||null;
        if(projectId){
          const access=getProjectAccess(db,user.id,projectId);
          if(!access){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
          if(!canWriteProject(db,user.id,projectId)){fail(res,403,"EDITOR_REQUIRED","Owner or editor access is required to compile a project storyboard.");return;}
        }
        try{
          const result=await generateStoryboard({input:body?.input});
          const recordId=randomUUID();
          audit(db,user.id,"creative.storyboard.generated","storyboard",recordId,{
            model:result.model,
            inputHash:result.storyboard.inputHash,
            sceneCount:result.storyboard.scenes.length,
            shotCount:result.storyboard.scenes.reduce((count,scene)=>count+scene.shots.length,0),
            durationSeconds:result.storyboard.durationSeconds,
            promptTokens:result.usage?.promptTokens??null,
            completionTokens:result.usage?.completionTokens??null,
            totalTokens:result.usage?.totalTokens??null
          },projectId);
          send(res,200,{...result,recordId},cors);return;
        }catch(error){
          const code=error.code||"STORYBOARD_COMPILATION_FAILED";
          const status=["STORYBOARD_INPUT_INVALID","STORYBOARD_DIRECTION_REQUIRED","STORYBOARD_DIRECTION_INVALID"].includes(code)?400:
            code==="STORYBOARD_OUTPUT_INVALID"||code==="STORYBOARD_DURATION_MISMATCH"?502:503;
          fail(res,status,code,error.message||"Storyboard compilation failed.");return;
        }
      }

      if(path==="/api/creative/director"&&req.method==="POST"){
        const body=await readJson(req,16*1024);
        const projectId=String(body?.projectId||"").trim()||null;
        if(projectId){
          const access=getProjectAccess(db,user.id,projectId);
          if(!access){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
          if(!canWriteProject(db,user.id,projectId)){fail(res,403,"EDITOR_REQUIRED","Owner or editor access is required to request project creative direction.");return;}
        }
        try{
          const result=await generateCreativeDirection({input:body?.input});
          const recordId=randomUUID();
          audit(db,user.id,"creative.director.generated","creative_plan",recordId,{
            model:result.model,
            inputHash:result.plan.inputHash,
            promptTokens:result.usage?.promptTokens??null,
            completionTokens:result.usage?.completionTokens??null,
            totalTokens:result.usage?.totalTokens??null,
            outputSchemaVersion:result.plan.schemaVersion
          },projectId);
          send(res,200,{...result,recordId},cors);return;
        }catch(error){
          const code=error.code||"CREATIVE_DIRECTOR_FAILED";
          const status=["CREATIVE_DIRECTOR_INPUT_INVALID","CREATIVE_DIRECTOR_BRIEF_REQUIRED"].includes(code)?400:
            code==="CREATIVE_DIRECTOR_OUTPUT_INVALID"||code==="CREATIVE_DIRECTOR_EMPTY_RESPONSE"?502:503;
          fail(res,status,code,error.message||"Creative direction could not be generated.");return;
        }
      }

      if(cloudTimelineApi && path==="/api/cloud/assets" && req.method==="POST"){
        const uploadResult=await cloudTimelineApi.uploadAsset({
          req,ownerId:user.id,projectId:String(req.headers["x-project-id"]||""),
          originalName:String(req.headers["x-file-name"]||"upload"),
          mediaType:String(req.headers["content-type"]||"application/octet-stream")
        });
        send(res,uploadResult.status,uploadResult.body,cors);return;
      }
      if(cloudTimelineApi && (path.startsWith("/api/cloud/timelines")||path.startsWith("/api/cloud/jobs")||path.startsWith("/api/cloud/assets")||path.startsWith("/api/cloud/projects")||path.startsWith("/api/cloud/transformations")||path.startsWith("/api/cloud/video"))){
        const isCloudMutation=(path.startsWith("/api/cloud/video")&&(req.method==="POST"))||(path.startsWith("/api/cloud/transformations")&&(req.method==="POST"||path.endsWith("/approve")&&req.method==="POST"||path.endsWith("/submit")&&req.method==="POST"))||(path.startsWith("/api/cloud/timelines")&&(req.method==="POST"||req.method==="PUT"))||(path==="/api/cloud/projects"&&req.method==="POST")||(path.startsWith("/api/cloud/projects/")&&(req.method==="PATCH"||req.method==="DELETE"));
        const body=isCloudMutation?await readJson(req,5*1024*1024):{};
        const cloudResult=await cloudTimelineApi.handle({
          method:req.method,path,ownerId:user.id,body,query:Object.fromEntries(url.searchParams.entries()),
          idempotencyKey:String(req.headers["idempotency-key"]||""),
          accessToken:requestAccessTokens.get(req)||null
        });
        if(cloudResult){send(res,cloudResult.status,cloudResult.body,cors);return;}
      }
      if(path==="/api/admin/ai-upscale/self-test"&&req.method==="POST"){
        const allowedAdmins=String(process.env.AI_UPSCALE_ADMIN_EMAILS||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean);
        if(!allowedAdmins.length||!allowedAdmins.includes(String(user.email||"").toLowerCase())){
          fail(res,403,"AI_UPSCALE_ADMIN_REQUIRED","An explicitly allowlisted administrator is required to run the worker inference self-test.");return;
        }
        const body=await readJson(req,16*1024);
        const sourceAssetId=String(body.sourceAssetId||"");
        if(!/^[0-9a-f-]{36}$/i.test(sourceAssetId)){
          fail(res,400,"AI_UPSCALE_INVALID_INPUT","Provide a valid uploaded image asset ID.");return;
        }
        const asset=getAccessibleAsset(db,user.id,sourceAssetId,true);
        if(!asset||!["image/png","image/jpeg","image/webp"].includes(asset.media_type)||asset.byte_size>5*1024*1024){
          fail(res,400,"AI_UPSCALE_INVALID_INPUT","The test asset must be an accessible PNG, JPEG or WebP image no larger than 5 MB.");return;
        }
        const inputPath=resolve(MEDIA_ROOT,asset.storage_path);
        const mediaPrefix=MEDIA_ROOT.endsWith(sep)?MEDIA_ROOT:MEDIA_ROOT+sep;
        if(!inputPath.startsWith(mediaPrefix)||!existsSync(inputPath)||!statSync(inputPath).isFile()){
          fail(res,400,"AI_UPSCALE_INVALID_INPUT","The uploaded test image is not available in managed media storage.");return;
        }
        try{
          const model=String(body.model||"realesrgan-x4plus");
          const scale=Number(body.scale||2);
          if(![2,3,4].includes(scale)){fail(res,400,"AI_UPSCALE_INVALID_OPTIONS","Self-test scale must be 2, 3 or 4.");return;}
          const result=await aiUpscaleAdapter.selfTest({inputPath,model,scale,format:"png"});
          audit(db,user.id,"ai_upscale.inference_self_test_passed","asset",asset.id,{engine:result.engine,model:result.model,scale:result.scale,outputBytes:result.outputBytes});
          send(res,200,{selfTest:{passed:true,executionVerified:result.executionVerified===true,inferenceVerified:result.inferenceVerified===true,qualityBenchmarkRequired:true,engine:result.engine,model:result.model,scale:result.scale,outputBytes:result.outputBytes}},cors);return;
        }catch(error){
          audit(db,user.id,"ai_upscale.inference_self_test_failed","asset",asset.id,{code:error.code||"AI_UPSCALE_SELF_TEST_FAILED"});
          fail(res,422,error.code||"AI_UPSCALE_SELF_TEST_FAILED",String(error.message||"Worker inference self-test failed.").slice(0,500));return;
        }
      }
      if(path==="/api/transformations"&&req.method==="GET"){
        const projectId=String(url.searchParams.get("projectId")||"");
        send(res,200,{plans:listTransformationPlans(db,user.id,projectId)},cors);return;
      }
      if(path==="/api/transformations"&&req.method==="POST"){
        const body=await readJson(req,64*1024);
        const result=createTransformationPlan(db,{ownerId:user.id,body,idempotencyKey:String(req.headers["idempotency-key"]||body.idempotencyKey||"")});
        if(!result.idempotentReplay)audit(db,user.id,"transformation.draft_created","transformation",result.plan.id,{operation:result.plan.operation},result.plan.projectId);
        send(res,result.idempotentReplay?200:201,result,cors);return;
      }
      const transformationMatch=path.match(/^\/api\/transformations\/([0-9a-f-]+)(?:\/(approve|submit))?$/i);
      if(transformationMatch){
        const plan=db.prepare("SELECT * FROM transformation_plans WHERE id=?").get(transformationMatch[1]);
        if(!plan||!getProjectAccess(db,user.id,plan.project_id)){fail(res,404,"TRANSFORMATION_NOT_FOUND","Transformation plan not found.");return;}
        if(!transformationMatch[2]&&req.method==="GET"){send(res,200,{plan:getTransformationPlan(db,user.id,plan.id)},cors);return;}
        if(transformationMatch[2]==="approve"&&req.method==="POST"){
          const body=await readJson(req,16*1024);
          const approved=approveTransformationPlan(db,{ownerId:user.id,planId:plan.id,body});
          audit(db,user.id,"transformation.approved","transformation",plan.id,{approvalId:approved.approval.id,estimatedCostMicros:approved.approval.estimatedCostMicros,currency:approved.approval.currency},plan.project_id);
          send(res,200,{plan:approved},cors);return;
        }
        if(transformationMatch[2]==="submit"&&req.method==="POST"){
          if(!canWriteProject(db,user.id,plan.project_id)){fail(res,403,"EDITOR_REQUIRED","Owner or editor access is required to submit a transformation.");return;}
          if(plan.status!=="approved"){fail(res,409,"TRANSFORMATION_APPROVAL_REQUIRED","Approve the plan and budget before submission.");return;}
          fail(res,409,"TRANSFORMATION_ADAPTER_UNAVAILABLE","No verified video-transformation adapter is enabled. The approved plan remains saved; no provider request or charge was made.");return;
        }
      }
      if(path==="/api/providers"&&req.method==="GET"){
        const aiUpscale=await aiUpscaleAdapter.probe();
        const catalog=getProviderCatalog(process.env,{ffmpeg:executableAvailable("ffmpeg"),ffprobe:executableAvailable("ffprobe"),aiUpscale});
        send(res,200,catalog,cors);return;
      }
      if(path==="/api/usage"&&req.method==="GET"){
        const projectId=url.searchParams.get("projectId");
        if(projectId&&!getProjectAccess(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        const rows=projectId
          ?db.prepare("SELECT id,project_id,job_id,workflow_run_id,node_id,provider,capability,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,estimated_cost_micros,created_at FROM model_usage_events WHERE project_id=? ORDER BY created_at DESC LIMIT 200").all(projectId)
          :db.prepare("SELECT id,project_id,job_id,workflow_run_id,node_id,provider,capability,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,estimated_cost_micros,created_at FROM model_usage_events WHERE owner_id=? ORDER BY created_at DESC LIMIT 200").all(user.id);
        const totals=rows.reduce((sum,row)=>({requests:sum.requests+1,promptTokens:sum.promptTokens+(row.prompt_tokens||0),completionTokens:sum.completionTokens+(row.completion_tokens||0),totalTokens:sum.totalTokens+(row.total_tokens||0),durationMs:sum.durationMs+(row.duration_ms||0)}),{requests:0,promptTokens:0,completionTokens:0,totalTokens:0,durationMs:0});
        ensureRemoteUsageTable(db);
        const usagePolicy=getRemoteUsagePolicy();
        const accountUsage=db.prepare("SELECT COUNT(*) AS count FROM remote_usage_reservations WHERE owner_id=? AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')").get(user.id).count;
        const projectUsage=projectId?db.prepare("SELECT COUNT(*) AS count FROM remote_usage_reservations WHERE owner_id=? AND project_id=? AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')").get(user.id,projectId).count:null;
        const remoteUsage={window:"rolling_24_hours",configurationValid:usagePolicy.valid,limit:usagePolicy.limit,used:accountUsage,remaining:usagePolicy.valid?Math.max(0,usagePolicy.limit-accountUsage):null,projectUsed:projectUsage,remoteDisabled:usagePolicy.valid&&usagePolicy.limit===0};
        send(res,200,{events:rows.map(row=>({id:row.id,projectId:row.project_id,jobId:row.job_id,workflowRunId:row.workflow_run_id,nodeId:row.node_id,provider:row.provider,capability:row.capability,model:row.model,promptTokens:row.prompt_tokens,completionTokens:row.completion_tokens,totalTokens:row.total_tokens,durationMs:row.duration_ms,estimatedCostMicros:row.estimated_cost_micros,createdAt:row.created_at})),totals,remoteUsage,costs:"not_estimated"},cors);return;
      }

      if(path==="/api/projects"&&req.method==="GET"){
        const rows=db.prepare("SELECT DISTINCT p.id,p.name,p.description,p.settings_json,p.revision,p.created_at,p.updated_at,CASE WHEN p.owner_id=? THEN 'owner' ELSE m.role END AS access_role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.member_id=? WHERE (p.owner_id=? OR m.member_id=?) AND p.archived_at IS NULL ORDER BY p.updated_at DESC").all(user.id,user.id,user.id,user.id);
        send(res,200,{projects:rows.map(x=>({...x,settings:parseJson(x.settings_json)}))},cors);return;
      }
      if(path==="/api/projects"&&req.method==="POST"){
        const body=await readJson(req);const name=String(body.name||"").trim().slice(0,160);
        if(!name){fail(res,400,"PROJECT_NAME_REQUIRED","Project name is required.");return;}
        const id=randomUUID();db.prepare("INSERT INTO projects(id,owner_id,name,description,settings_json) VALUES(?,?,?,?,?)").run(id,user.id,name,String(body.description||"").slice(0,4000),json(body.settings));
        audit(db,user.id,"project.created","project",id,{name});send(res,201,{project:{id,name,description:body.description||"",revision:1}},cors);return;
      }
      const membersMatch=path.match(/^\/api\/projects\/([0-9a-f-]+)\/members(?:\/([0-9a-f-]+))?$/i);
      if(membersMatch){
        const projectId=membersMatch[1],access=getProjectAccess(db,user.id,projectId);
        if(!access){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        if(req.method==="GET"){
          const members=db.prepare("SELECT u.id,u.email,m.role,m.created_at FROM project_members m JOIN users u ON u.id=m.member_id WHERE m.project_id=? ORDER BY m.created_at").all(projectId);
          send(res,200,{owner:{id:access.owner_id},members:members.map(m=>({id:m.id,email:m.email,role:m.role,createdAt:m.created_at}))},cors);return;
        }
        if(access.access_role!=="owner"){fail(res,403,"OWNER_REQUIRED","Only the project owner can manage membership.");return;}
        if(req.method==="POST"&&!membersMatch[2]){
          const body=await readJson(req),email=String(body.email||"").trim().toLowerCase(),role=String(body.role||"viewer");
          if(!["editor","reviewer","viewer"].includes(role)){fail(res,400,"INVALID_ROLE","Choose editor, reviewer or viewer.");return;}
          const member=db.prepare("SELECT id,email FROM users WHERE email=? COLLATE NOCASE").get(email);
          if(!member){fail(res,404,"USER_NOT_FOUND","This email has no account in this workspace. Ask the person to register first.");return;}
          if(member.id===access.owner_id){fail(res,409,"OWNER_MEMBERSHIP","The owner already has full access.");return;}
          db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?) ON CONFLICT(project_id,member_id) DO UPDATE SET role=excluded.role")
            .run(projectId,member.id,role,user.id);
          audit(db,user.id,"project.member_added","project_member",member.id,{role,email},projectId);
          send(res,201,{member:{id:member.id,email:member.email,role}},cors);return;
        }
        if(req.method==="DELETE"&&membersMatch[2]){
          db.prepare("DELETE FROM project_members WHERE project_id=? AND member_id=?").run(projectId,membersMatch[2]);
          audit(db,user.id,"project.member_removed","project_member",membersMatch[2],{},projectId);
          send(res,200,{ok:true},cors);return;
        }
      }
      const projectMatch=path.match(/^\/api\/projects\/([0-9a-f-]+)$/i);
      if(projectMatch){
        const id=projectMatch[1],project=getProjectAccess(db,user.id,id);if(!project){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        if(req.method==="GET"){send(res,200,{project:{id:project.id,name:project.name,description:project.description,settings:parseJson(project.settings_json),revision:project.revision,accessRole:project.access_role}},cors);return;}
        if(req.method==="PUT"){
          if(project.access_role!=="owner"){fail(res,403,"OWNER_REQUIRED","Only the project owner can change project settings.");return;}
          const body=await readJson(req);if(Number(body.revision)!==project.revision){fail(res,409,"REVISION_CONFLICT","Project changed since it was loaded. Refresh and retry.");return;}
          const name=String(body.name||project.name).trim().slice(0,160);
          db.prepare("UPDATE projects SET name=?,description=?,settings_json=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?")
            .run(name,String(body.description??project.description).slice(0,4000),json(body.settings??parseJson(project.settings_json)),now(),id,user.id);
          audit(db,user.id,"project.updated","project",id,{revision:project.revision+1});send(res,200,{ok:true,revision:project.revision+1},cors);return;
        }
        if(req.method==="DELETE"){
          if(project.access_role!=="owner"){fail(res,403,"OWNER_REQUIRED","Only the project owner can archive this project.");return;}
          db.prepare("UPDATE projects SET archived_at=?,updated_at=? WHERE id=? AND owner_id=?").run(now(),now(),id,user.id);
          audit(db,user.id,"project.archived","project",id,{});send(res,200,{ok:true},cors);return;
        }
      }


      const researchImportMatch=path.match(new RegExp("^/api/projects/([0-9a-f-]+)/research/import$","i"));
      if(researchImportMatch&&req.method==="POST"){
        const projectId=researchImportMatch[1],access=getProjectAccess(db,user.id,projectId);
        if(!access){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        if(!canWriteProject(db,user.id,projectId)){fail(res,403,"EDITOR_REQUIRED","Owner or editor access is required to import research.");return;}
        const body=await readJson(req,16*1024);
        const current=db.prepare("SELECT revision,document_json FROM project_workspace_documents WHERE project_id=?").get(projectId);
        const expected=Number(body.revision);
        if(!Number.isInteger(expected)||expected!==(current?.revision||0)){fail(res,409,"REVISION_CONFLICT","Project knowledge changed since it was loaded. Refresh before importing.");return;}
        const extracted=await importResearchUrl(body.url);
        const timestamp=now(),sourceId=randomUUID(),recordId=randomUUID();
        const prior=parseJson(current?.document_json,{});
        const source={id:sourceId,title:extracted.title,url:extracted.url,sourceType:"Web article",author:extracted.author,publishedAt:extracted.publishedAt,accessedAt:extracted.fetchedAt,summary:"Imported "+extracted.characterCount+" source characters ("+extracted.contentType+").",rights:"Imported public webpage; verify copyright and licensing before reuse.",createdAt:timestamp};
        const record={id:recordId,title:extracted.title+" — extracted source text",content:extracted.text,tags:["imported-source","needs-review"],sourceIds:[sourceId],kind:"Source extract",status:"Needs verification",createdAt:timestamp,updatedAt:timestamp};
        let document;
        try{document=sanitizeCreativeWorkspaceDocument({...prior,researchSources:[...(prior.researchSources||[]),source],knowledgeRecords:[...(prior.knowledgeRecords||[]),record]});}
        catch(error){fail(res,400,error.code||"INVALID_WORKSPACE_DOCUMENT",error.message);return;}
        const nextRevision=expected+1;
        const changed=current
          ?db.prepare("UPDATE project_workspace_documents SET revision=?,document_json=?,updated_at=? WHERE project_id=? AND revision=?").run(nextRevision,json(document),timestamp,projectId,expected)
          :db.prepare("INSERT OR IGNORE INTO project_workspace_documents(project_id,revision,document_json,updated_at) VALUES(?,?,?,?)").run(projectId,nextRevision,json(document),timestamp);
        if(changed.changes!==1){fail(res,409,"REVISION_CONFLICT","Project knowledge changed while importing. Refresh and retry.");return;}
        audit(db,user.id,"workspace.research_imported","project_workspace",projectId,{sourceId,recordId,host:new URL(extracted.url).hostname,characters:extracted.text.length},projectId);
        send(res,201,{ok:true,revision:nextRevision,source,record,extracted:{contentType:extracted.contentType,characterCount:extracted.characterCount}},cors);return;
      }

      const workspaceMatch=path.match(new RegExp("^/api/projects/([0-9a-f-]+)/workspace$","i"));
      if(workspaceMatch){
        const projectId=workspaceMatch[1],access=getProjectAccess(db,user.id,projectId);
        if(!access){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        if(req.method==="GET"){
          const row=db.prepare("SELECT revision,document_json,updated_at FROM project_workspace_documents WHERE project_id=?").get(projectId);
          send(res,200,{document:row?parseJson(row.document_json,{}):{},revision:row?.revision||0,updatedAt:row?.updated_at||null},cors);return;
        }
        if(req.method==="PUT"){
          if(!canWriteProject(db,user.id,projectId)){fail(res,403,"EDITOR_REQUIRED","Owner or editor access is required to save creative workspace data.");return;}
          const body=await readJson(req,3*1024*1024);
          let document;
          const prior=db.prepare("SELECT document_json FROM project_workspace_documents WHERE project_id=?").get(projectId);
          try{document=sanitizeCreativeWorkspaceDocument({...parseJson(prior?.document_json,{}),...(body.document||{})});}catch(error){fail(res,400,error.code||"INVALID_WORKSPACE_DOCUMENT",error.message);return;}
          const current=db.prepare("SELECT revision FROM project_workspace_documents WHERE project_id=?").get(projectId);
          const expected=Number(body.revision);
          if(!Number.isInteger(expected)||expected!==(current?.revision||0)){fail(res,409,"REVISION_CONFLICT","Creative workspace changed since it was loaded. Refresh before saving again.");return;}
          const nextRevision=expected+1;
          const changed=current
            ?db.prepare("UPDATE project_workspace_documents SET revision=?,document_json=?,updated_at=? WHERE project_id=? AND revision=?").run(nextRevision,json(document),now(),projectId,expected)
            :db.prepare("INSERT OR IGNORE INTO project_workspace_documents(project_id,revision,document_json,updated_at) VALUES(?,?,?,?)").run(projectId,nextRevision,json(document),now());
          if(changed.changes!==1){fail(res,409,"REVISION_CONFLICT","Creative workspace changed while saving. Refresh and retry.");return;}
          audit(db,user.id,"workspace.document_saved","project_workspace",projectId,{revision:nextRevision},projectId);
          send(res,200,{ok:true,revision:nextRevision,updatedAt:now()},cors);return;
        }
      }

      if(path==="/api/assets"&&req.method==="GET"){
        const projectId=url.searchParams.get("projectId");
        const rows=projectId&&!getProjectAccess(db,user.id,projectId)?[]:db.prepare("SELECT id,project_id,original_name,media_type,byte_size,sha256,derivative_of,metadata_json,created_at FROM assets WHERE deleted_at IS NULL AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?)) AND (? IS NULL OR project_id=?) ORDER BY created_at DESC").all(user.id,user.id,user.id,projectId,projectId);
        send(res,200,{assets:rows.map(x=>({id:x.id,projectId:x.project_id,name:x.original_name,mediaType:x.media_type,size:x.byte_size,sha256:x.sha256,derivativeOf:x.derivative_of,metadata:parseJson(x.metadata_json),createdAt:x.created_at}))},cors);return;
      }
      if(path==="/api/assets"&&req.method==="POST"){
        const result=await storeUpload(req,user,req.headers["x-project-id"]||null);send(res,201,{asset:result},cors);return;
      }
      const assetMatch=path.match(/^\/api\/assets\/([0-9a-f-]+)(?:\/(file))?$/i);
      if(assetMatch){
        const asset=getAccessibleAsset(db,user.id,assetMatch[1],req.method==="DELETE");if(!asset){fail(res,404,"ASSET_NOT_FOUND","Asset not found.");return;}
        if(assetMatch[2]==="file"&&req.method==="GET"){
          const file=resolve(MEDIA_ROOT,asset.storage_path);const mediaPrefix=MEDIA_ROOT.endsWith(sep)?MEDIA_ROOT:MEDIA_ROOT+sep;if(!file.startsWith(mediaPrefix)){fail(res,404,"ASSET_NOT_FOUND","Asset not found.");return;}
          res.writeHead(200,{"content-type":asset.media_type,"content-length":asset.byte_size,"content-disposition":`inline; filename="${safeName(asset.original_name)}"`,...SECURITY_HEADERS,...cors});
          createReadStream(file).pipe(res);return;
        }
        if(req.method==="DELETE"){
          const changed=db.prepare("UPDATE assets SET deleted_at=? WHERE id=? AND deleted_at IS NULL").run(now(),asset.id);
          if(changed.changes!==1){fail(res,404,"ASSET_NOT_FOUND","Asset not found.");return;}
          audit(db,user.id,"asset.archived","asset",asset.id,{},asset.project_id);send(res,200,{ok:true},cors);return;
        }
      }

      if(path==="/api/workflows"&&req.method==="GET"){
        const rows=db.prepare("SELECT id,project_id,name,revision,graph_json,graph_hash,created_at,updated_at FROM workflows WHERE (project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY updated_at DESC").all(user.id,user.id,user.id);
        send(res,200,{workflows:rows.map(x=>({id:x.id,projectId:x.project_id,name:x.name,revision:x.revision,graph:parseJson(x.graph_json),graphHash:x.graph_hash,createdAt:x.created_at,updatedAt:x.updated_at}))},cors);return;
      }
      if(path==="/api/workflows"&&req.method==="POST"){
        const body=await readJson(req);const name=String(body.name||"Untitled workflow").trim().slice(0,160);const graph=body.graph;
        if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)){fail(res,400,"INVALID_WORKFLOW","A workflow graph with nodes and edges is required.");return;}
        const validation=validateWorkflowGraph(graph);
        if(!validation.valid){send(res,422,{error:{code:"WORKFLOW_INVALID",message:"Workflow graph failed validation.",issues:validation.issues}},cors);return;}
        if(body.projectId&&!canWriteProject(db,user.id,body.projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
        const id=randomUUID(),projectId=body.projectId||null,persistedGraph={...graph,id,projectId:projectId||""},graphJson=json(persistedGraph),graphHash=hash(graphJson);
        db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,graph_json,graph_hash) VALUES(?,?,?,?,?,?)").run(id,user.id,projectId,name,graphJson,graphHash);
        audit(db,user.id,"workflow.created","workflow",id,{graphHash},projectId);send(res,201,{workflow:{id,projectId,name,revision:1,graphHash,graph:persistedGraph}},cors);return;
      }

      if(path==="/api/timelines"&&req.method==="GET"){
        const rows=db.prepare("SELECT id,project_id,name,revision,created_at,updated_at FROM timelines WHERE archived_at IS NULL AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?)) ORDER BY updated_at DESC").all(user.id,user.id,user.id);
        send(res,200,{timelines:rows.map(x=>({id:x.id,projectId:x.project_id,name:x.name,revision:x.revision,createdAt:x.created_at,updatedAt:x.updated_at}))},cors);return;
      }
      if(path==="/api/timelines"&&req.method==="POST"){
        const body=await readJson(req,4*1024*1024),timeline=body.timeline;
        const projectId=body.projectId||timeline?.projectId||null;
        if(projectId&&!canWriteProject(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
        const validation=validateTimelineDocument(timeline,db,user.id);
        if(!validation.valid){send(res,422,{error:{code:"TIMELINE_INVALID",message:"Timeline failed validation.",issues:validation.issues}},cors);return;}
        const id=randomUUID(),name=String(body.name||timeline.name||"Untitled sequence").trim().slice(0,160);
        const saved={...timeline,id,projectId,name,revision:1},otio=body.otio||null;
        db.exec("BEGIN IMMEDIATE");
        try{
          db.prepare("INSERT INTO timelines(id,owner_id,project_id,name,timeline_json,otio_json) VALUES(?,?,?,?,?,?)")
            .run(id,user.id,projectId,name,json(saved),otio?json(otio):null);
          insertTimelineVersion(db,{timelineId:id,ownerId:user.id,projectId,revision:1,name,summary:String(body.versionSummary||"Initial version"),timeline:saved,otio,createdBy:user.id});
          audit(db,user.id,"timeline.created","timeline",id,{revision:1},projectId);
          db.exec("COMMIT");
        }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
        send(res,201,{timeline:{id,projectId,name,revision:1,document:saved}},cors);return;
      }
      const timelineVersionsMatch=path.match(/^\/api\/timelines\/([0-9a-f-]+)\/versions(?:\/([0-9a-f-]+))?$/i);
      if(timelineVersionsMatch&&req.method==="GET"){
        const record=db.prepare("SELECT id,owner_id,project_id FROM timelines WHERE id=? AND archived_at IS NULL AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))").get(timelineVersionsMatch[1],user.id,user.id,user.id);
        if(!record){fail(res,404,"TIMELINE_NOT_FOUND","Timeline not found.");return;}
        if(timelineVersionsMatch[2]){
          const version=db.prepare("SELECT * FROM timeline_versions WHERE id=? AND timeline_id=? AND owner_id=?").get(timelineVersionsMatch[2],record.id,record.owner_id);
          if(!version){fail(res,404,"TIMELINE_VERSION_NOT_FOUND","Timeline version not found.");return;}
          try{send(res,200,{version:mapTimelineVersion(version,true)},cors);}
          catch(error){fail(res,409,"TIMELINE_VERSION_CORRUPT",error.message);}
          return;
        }
        const versions=db.prepare("SELECT id,timeline_id,owner_id,project_id,revision,parent_version_id,restored_from_version_id,name,summary,content_hash,created_by,created_at FROM timeline_versions WHERE timeline_id=? AND owner_id=? ORDER BY revision DESC LIMIT 100").all(record.id,record.owner_id);
        send(res,200,{versions:versions.map(row=>mapTimelineVersion(row))},cors);return;
      }
      const timelineRestoreMatch=path.match(/^\/api\/timelines\/([0-9a-f-]+)\/restore$/i);
      if(timelineRestoreMatch&&req.method==="POST"){
        const record=db.prepare("SELECT * FROM timelines WHERE id=? AND archived_at IS NULL AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))").get(timelineRestoreMatch[1],user.id,user.id,user.id);
        if(!record){fail(res,404,"TIMELINE_NOT_FOUND","Timeline not found.");return;}
        if(record.project_id?!canWriteProject(db,user.id,record.project_id):record.owner_id!==user.id){fail(res,403,"EDITOR_REQUIRED","Editor access is required to restore this timeline.");return;}
        const body=await readJson(req,1024*1024),expectedRevision=Number(body.expectedRevision),sourceVersionId=String(body.sourceVersionId||"");
        if(!Number.isInteger(expectedRevision)||expectedRevision<1||!sourceVersionId){fail(res,400,"TIMELINE_RESTORE_INVALID","A current revision and source version are required.");return;}
        db.exec("BEGIN IMMEDIATE");
        try{
          const current=db.prepare("SELECT * FROM timelines WHERE id=? AND archived_at IS NULL").get(record.id);
          if(!current||current.revision!==expectedRevision){db.exec("ROLLBACK");fail(res,409,"REVISION_CONFLICT","Timeline changed before restore. Refresh and compare again.");return;}
          if(current.project_id?!canWriteProject(db,user.id,current.project_id):current.owner_id!==user.id){db.exec("ROLLBACK");fail(res,403,"EDITOR_REQUIRED","Editor access is required to restore this timeline.");return;}
          const source=db.prepare("SELECT * FROM timeline_versions WHERE id=? AND timeline_id=? AND owner_id=?").get(sourceVersionId,current.id,current.owner_id);
          if(!source){db.exec("ROLLBACK");fail(res,404,"TIMELINE_VERSION_NOT_FOUND","Source version not found for this timeline.");return;}
          let sourceVersion;
          try{sourceVersion=mapTimelineVersion(source,true);}catch(error){db.exec("ROLLBACK");fail(res,409,"TIMELINE_VERSION_CORRUPT",error.message);return;}
          const sourceDocument=sourceVersion.document,validation=validateTimelineDocument(sourceDocument,db,user.id);
          if(!validation.valid){db.exec("ROLLBACK");send(res,422,{error:{code:"TIMELINE_VERSION_INVALID",message:"The selected historical version no longer passes current asset and timeline validation.",issues:validation.issues}},cors);return;}
          const parentVersionId=ensureTimelineBaseline(db,current),revision=current.revision+1;
          const saved={...sourceDocument,id:current.id,projectId:current.project_id,name:source.name,revision};
          const otio=sourceVersion.otio;
          const changed=db.prepare("UPDATE timelines SET name=?,revision=?,timeline_json=?,otio_json=?,updated_at=? WHERE id=? AND revision=?")
            .run(saved.name,revision,json(saved),otio?json(otio):null,now(),current.id,current.revision);
          if(changed.changes!==1){db.exec("ROLLBACK");fail(res,409,"REVISION_CONFLICT","Timeline changed while restoring. Refresh and retry.");return;}
          const version=insertTimelineVersion(db,{timelineId:current.id,ownerId:current.owner_id,projectId:current.project_id,revision,parentVersionId,restoredFromVersionId:source.id,name:saved.name,summary:String(body.summary||("Restored from revision "+source.revision)),timeline:saved,otio,createdBy:user.id});
          audit(db,user.id,"timeline.restored","timeline",current.id,{revision,restoredFromVersionId:source.id,restoredFromRevision:source.revision},current.project_id);
          db.exec("COMMIT");
          send(res,200,{timeline:{id:current.id,projectId:current.project_id,name:saved.name,revision,document:saved,updatedAt:now()},version},cors);return;
        }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
      }
      const timelineMatch=path.match(/^\/api\/timelines\/([0-9a-f-]+)(?:\/(otio))?$/i);
      if(timelineMatch){
        const record=db.prepare("SELECT * FROM timelines WHERE id=? AND archived_at IS NULL AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))").get(timelineMatch[1],user.id,user.id,user.id);
        if(!record){fail(res,404,"TIMELINE_NOT_FOUND","Timeline not found.");return;}
        if(timelineMatch[2]==="otio"&&req.method==="GET"){
          if(!record.otio_json){fail(res,404,"INTERCHANGE_NOT_AVAILABLE","No interchange export has been saved.");return;}
          send(res,200,{otio:parseJson(record.otio_json)},cors);return;
        }
        if(!timelineMatch[2]&&req.method==="GET"){
          send(res,200,{timeline:{id:record.id,projectId:record.project_id,name:record.name,revision:record.revision,document:parseJson(record.timeline_json),createdAt:record.created_at,updatedAt:record.updated_at}},cors);return;
        }
        if(!timelineMatch[2]&&req.method==="PUT"){
          if(record.project_id?!canWriteProject(db,user.id,record.project_id):record.owner_id!==user.id){fail(res,403,"EDITOR_REQUIRED","Editor access is required to edit this timeline.");return;}
          const body=await readJson(req,4*1024*1024);
          if(Number(body.revision)!==record.revision){fail(res,409,"REVISION_CONFLICT","Timeline changed since it was loaded. Refresh and retry.");return;}
          const timeline=body.timeline,validation=validateTimelineDocument(timeline,db,user.id);
          if(!validation.valid){send(res,422,{error:{code:"TIMELINE_INVALID",message:"Timeline failed validation.",issues:validation.issues}},cors);return;}
          const projectId=body.projectId??record.project_id;
          if(projectId&&!canWriteProject(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
          const revision=record.revision+1,name=String(body.name||timeline.name||record.name).trim().slice(0,160);
          const saved={...timeline,id:record.id,projectId,name,revision},otio=body.otio?body.otio:(record.otio_json?parseJson(record.otio_json):null);
          db.exec("BEGIN IMMEDIATE");
          try{
            const current=db.prepare("SELECT * FROM timelines WHERE id=? AND archived_at IS NULL").get(record.id);
            if(!current||current.revision!==record.revision){db.exec("ROLLBACK");fail(res,409,"REVISION_CONFLICT","Timeline changed while saving. Refresh and retry.");return;}
            if(current.project_id?!canWriteProject(db,user.id,current.project_id):current.owner_id!==user.id){db.exec("ROLLBACK");fail(res,403,"EDITOR_REQUIRED","Editor access is required to edit this timeline.");return;}
            if(projectId&&!canWriteProject(db,user.id,projectId)){db.exec("ROLLBACK");fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
            const parentVersionId=ensureTimelineBaseline(db,current);
            const changed=db.prepare("UPDATE timelines SET project_id=?,name=?,revision=?,timeline_json=?,otio_json=?,updated_at=? WHERE id=? AND revision=?")
              .run(projectId,name,revision,json(saved),otio?json(otio):null,now(),record.id,record.revision);
            if(changed.changes!==1){db.exec("ROLLBACK");fail(res,409,"REVISION_CONFLICT","Timeline changed while saving. Refresh and retry.");return;}
            insertTimelineVersion(db,{timelineId:record.id,ownerId:record.owner_id,projectId,revision,parentVersionId,name,summary:String(body.versionSummary||("Saved revision "+revision)),timeline:saved,otio,createdBy:user.id});
            audit(db,user.id,"timeline.updated","timeline",record.id,{revision},projectId);
            db.exec("COMMIT");
          }catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
          send(res,200,{ok:true,revision},cors);return;
        }
        if(!timelineMatch[2]&&req.method==="DELETE"){
          if(record.owner_id!==user.id){fail(res,403,"OWNER_REQUIRED","Only the timeline owner can archive it.");return;}
          db.prepare("UPDATE timelines SET archived_at=?,updated_at=? WHERE id=? AND owner_id=?").run(now(),now(),record.id,user.id);
          audit(db,user.id,"timeline.archived","timeline",record.id,{},record.project_id);
          send(res,200,{ok:true},cors);return;
        }
      }
      const workflowRunMatch=path.match(/^\/api\/workflows\/([0-9a-f-]+)\/run$/i);
      if(workflowRunMatch&&req.method==="POST"){
        const workflow=db.prepare("SELECT * FROM workflows WHERE id=? AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))")
          .get(workflowRunMatch[1],user.id,user.id,user.id);
        if(!workflow){fail(res,404,"WORKFLOW_NOT_FOUND","Workflow not found.");return;}
        if(workflow.project_id?!canWriteProject(db,user.id,workflow.project_id):workflow.owner_id!==user.id){fail(res,403,"EDITOR_REQUIRED","Editor access is required to run this workflow.");return;}
        const graph=parseJson(workflow.graph_json),validation=validateWorkflowGraph(graph);
        if(!validation.valid){send(res,422,{error:{code:"WORKFLOW_INVALID",message:"Workflow graph failed validation.",issues:validation.issues}},cors);return;}
        const body=await readJson(req),target=body.target||{kind:"all"},plan=planWorkflowTarget(graph,target);
        if(!plan.valid){send(res,422,{error:{code:"WORKFLOW_TARGET_INVALID",message:"Workflow run target failed validation.",issues:plan.issues}},cors);return;}
        for(const nodeId of plan.reusedNodeIds){
          const node=graph.nodes.find(item=>item.id===nodeId);
          for(const assetId of node?.lockedOutputIds||[]){
            if(!getAccessibleAsset(db,user.id,String(assetId),false)){fail(res,422,"LOCKED_OUTPUT_MISSING","A locked node references an output asset that is not accessible.");return;}
          }
        }
        const runId=randomUUID(),jobId=randomUUID();
        const snapshot={...graph,runPlan:{target:plan.target,includedNodeIds:plan.includedNodeIds,executionOrder:plan.executionOrder,runNodeIds:plan.runNodeIds,reusedNodeIds:plan.reusedNodeIds}};
        const snapshotJson=json(snapshot),snapshotHash=hash(snapshotJson);
        db.prepare("INSERT INTO workflow_runs(id,workflow_id,owner_id,project_id,workflow_revision,snapshot_hash,snapshot_json,status,job_id) VALUES(?,?,?,?,?,?,?,'queued',?)")
          .run(runId,workflow.id,user.id,workflow.project_id,workflow.revision,snapshotHash,snapshotJson,jobId);
        for(const nodeId of plan.includedNodeIds){
          const node=graph.nodes.find(item=>item.id===nodeId),reused=plan.reusedNodeIds.includes(nodeId);
          db.prepare("INSERT INTO workflow_node_runs(id,run_id,node_id,status,output_json) VALUES(?,?,?,?,?)")
            .run(randomUUID(),runId,nodeId,reused?"skipped":"pending",reused?json({lockedOutputIds:node?.lockedOutputIds||[]}):null);
        }
        db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,?,?,'workflow.execute','queued',0,?)")
          .run(jobId,user.id,workflow.project_id,json({runId}));
        addJobEvent(db,jobId,user.id,"job.queued",{jobType:"workflow.execute",runId});
        audit(db,user.id,"workflow.run_queued","workflow_run",runId,{workflowId:workflow.id,revision:workflow.revision,snapshotHash,target:plan.target,includedNodes:plan.includedNodeIds},workflow.project_id);
        send(res,202,{runId,jobId,status:"queued",snapshotHash,target:plan.target,executionOrder:plan.executionOrder,reusedNodeIds:plan.reusedNodeIds},cors);return;
      }
      const workflowRunsMatch=path.match(/^\/api\/workflows\/([0-9a-f-]+)\/runs$/i);
      if(workflowRunsMatch&&req.method==="GET"){
        const workflow=db.prepare("SELECT * FROM workflows WHERE id=? AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))")
          .get(workflowRunsMatch[1],user.id,user.id,user.id);
        if(!workflow){fail(res,404,"WORKFLOW_NOT_FOUND","Workflow not found.");return;}
        const runs=db.prepare("SELECT id,workflow_id,workflow_revision,snapshot_hash,status,job_id,error_json,created_at,updated_at,completed_at FROM workflow_runs WHERE workflow_id=? ORDER BY created_at DESC LIMIT 50").all(workflow.id);
        send(res,200,{runs:runs.map(run=>({...run,error:parseJson(run.error_json,null)}))},cors);return;
      }
      const workflowRunDetail=path.match(/^\/api\/workflow-runs\/([0-9a-f-]+)(?:\/(approve))?$/i);
      if(workflowRunDetail){
        const run=db.prepare("SELECT * FROM workflow_runs WHERE id=? AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))")
          .get(workflowRunDetail[1],user.id,user.id,user.id);
        if(!run){fail(res,404,"WORKFLOW_RUN_NOT_FOUND","Workflow run not found.");return;}
        const access=run.project_id?getProjectAccess(db,user.id,run.project_id):{access_role:run.owner_id===user.id?"owner":null};
        if(req.method==="GET"&&!workflowRunDetail[2]){
          const nodes=db.prepare("SELECT node_id,status,attempt,input_json,output_json,error_json,started_at,completed_at FROM workflow_node_runs WHERE run_id=? ORDER BY rowid").all(run.id);
          const snapshot=parseJson(run.snapshot_json);
          send(res,200,{run:{id:run.id,workflowId:run.workflow_id,revision:run.workflow_revision,status:run.status,snapshotHash:run.snapshot_hash,target:snapshot.runPlan?.target||{kind:"all"},executionOrder:snapshot.runPlan?.executionOrder||[],error:parseJson(run.error_json,null),createdAt:run.created_at,updatedAt:run.updated_at,completedAt:run.completed_at},nodes:nodes.map(node=>({...node,input:parseJson(node.input_json,{}),output:parseJson(node.output_json,null),error:parseJson(node.error_json,null)}))},cors);return;
        }
        if(req.method==="POST"&&workflowRunDetail[2]==="approve"){
          if(!["owner","editor","reviewer"].includes(access?.access_role||"")){fail(res,403,"REVIEWER_REQUIRED","Reviewer permission is required to approve this step.");return;}
          if(run.status!=="awaiting_approval"){fail(res,409,"APPROVAL_NOT_PENDING","This workflow is not waiting for approval.");return;}
          const waiting=db.prepare("SELECT * FROM workflow_node_runs WHERE run_id=? AND status='awaiting_approval' ORDER BY rowid LIMIT 1").get(run.id);
          if(!waiting){fail(res,409,"APPROVAL_NODE_NOT_FOUND","No approval node is waiting.");return;}
          const graph=parseJson(run.snapshot_json),node=graph.nodes.find(item=>item.id===waiting.node_id),nodeInput=parseJson(waiting.input_json,{});
          const passthrough=nodeInput.media??nodeInput.asset??nodeInput.input??null;
          const output=Object.fromEntries((node?.outputs||[]).map(port=>[port.id,nodeInput[port.id]??passthrough]));
          output.approved=true;output.approvedBy=user.id;output.approvedAt=now();
          db.prepare("UPDATE workflow_node_runs SET status='completed',output_json=?,completed_at=? WHERE id=?").run(json(output),now(),waiting.id);
          const jobId=randomUUID();
          db.prepare("UPDATE workflow_runs SET status='queued',job_id=?,updated_at=?,error_json=NULL WHERE id=?").run(jobId,now(),run.id);
          db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,?,?,'workflow.execute','queued',0,?)").run(jobId,run.owner_id,run.project_id,json({runId:run.id}));
          addJobEvent(db,jobId,run.owner_id,"job.queued",{jobType:"workflow.execute",runId:run.id,approvedNodeId:waiting.node_id});
          audit(db,user.id,"workflow.step_approved","workflow_run",run.id,{nodeId:waiting.node_id},run.project_id);
          send(res,202,{runId:run.id,jobId,status:"queued"},cors);return;
        }
      }
      const workflowMatch=path.match(/^\/api\/workflows\/([0-9a-f-]+)$/i);
      if(workflowMatch){
        const workflow=db.prepare("SELECT * FROM workflows WHERE id=? AND ((project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))").get(workflowMatch[1],user.id,user.id,user.id);
        if(!workflow){fail(res,404,"WORKFLOW_NOT_FOUND","Workflow not found.");return;}
        if(req.method==="GET"){
          send(res,200,{workflow:{id:workflow.id,projectId:workflow.project_id,name:workflow.name,revision:workflow.revision,graph:parseJson(workflow.graph_json),graphHash:workflow.graph_hash,createdAt:workflow.created_at,updatedAt:workflow.updated_at}},cors);return;
        }
        if(req.method==="PUT"){
          if(workflow.project_id?!canWriteProject(db,user.id,workflow.project_id):workflow.owner_id!==user.id){fail(res,403,"EDITOR_REQUIRED","Editor access is required to change this workflow.");return;}
          const body=await readJson(req);
          if(Number(body.revision)!==workflow.revision){fail(res,409,"REVISION_CONFLICT","Workflow changed since it was loaded. Refresh and retry.");return;}
          if(!body.graph||!Array.isArray(body.graph.nodes)||!Array.isArray(body.graph.edges)){fail(res,400,"INVALID_WORKFLOW","A workflow graph with nodes and edges is required.");return;}
          const validation=validateWorkflowGraph(body.graph);
          if(!validation.valid){send(res,422,{error:{code:"WORKFLOW_INVALID",message:"Workflow graph failed validation.",issues:validation.issues}},cors);return;}
          const graphJson=json(body.graph),graphHash=hash(graphJson),name=String(body.name||workflow.name).trim().slice(0,160);
          const changed=db.prepare("UPDATE workflows SET name=?,graph_json=?,graph_hash=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
            .run(name,graphJson,graphHash,now(),workflow.id,workflow.revision);
          if(changed.changes!==1){fail(res,409,"REVISION_CONFLICT","Workflow changed while saving. Refresh and retry.");return;}
          audit(db,user.id,"workflow.updated","workflow",workflow.id,{revision:workflow.revision+1,graphHash},workflow.project_id);
          send(res,200,{ok:true,revision:workflow.revision+1,graphHash},cors);return;
        }
      }
      if(path==="/api/jobs"&&req.method==="GET"){
        const rows=db.prepare("SELECT * FROM jobs WHERE (project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY created_at DESC LIMIT 100").all(user.id,user.id,user.id);
        send(res,200,{jobs:rows.map(recordJob)},cors);return;
      }
      if(path==="/api/jobs"&&req.method==="POST"){
        const body=await readJson(req);const type=String(body.jobType||"");
        if(!MEDIA_JOBS.has(type)){fail(res,409,"ENGINE_UNAVAILABLE","This capability has no connected execution adapter yet. No paid request was sent.");return;}
        let projectId=body.projectId||null;
        if(type==="timeline.render"){
          const timeline=db.prepare("SELECT * FROM timelines WHERE id=? AND archived_at IS NULL").get(String(body.timelineId||""));
          if(!timeline){fail(res,404,"TIMELINE_NOT_FOUND","Timeline not found.");return;}
          if(timeline.project_id?!canWriteProject(db,user.id,timeline.project_id):timeline.owner_id!==user.id){fail(res,404,"TIMELINE_NOT_FOUND","Timeline not found or editor access required.");return;}
          if(projectId&&projectId!==timeline.project_id){fail(res,400,"PROJECT_MISMATCH","Job project must match the saved timeline.");return;}
          projectId=timeline.project_id;
        }else{
          if(projectId&&!canWriteProject(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
          if(!body.sourceAssetId||!getAccessibleAsset(db,user.id,String(body.sourceAssetId),true)){fail(res,404,"SOURCE_ASSET_NOT_FOUND","Choose a source asset you own or can edit.");return;}
        }
        const key=String(req.headers["idempotency-key"]||body.idempotencyKey||"").slice(0,180);
        const input={...body};delete input.idempotencyKey;
        const inputJson=stableJson(input);
        if(key){
          const existing=db.prepare("SELECT * FROM jobs WHERE owner_id=? AND idempotency_key=?").get(user.id,key);
          if(existing){
            const sameRequest=existing.job_type===type&&existing.project_id===projectId&&stableJson(parseJson(existing.input_json))===inputJson;
            if(!sameRequest){fail(res,409,"IDEMPOTENCY_CONFLICT","This idempotency key was already used for a different job request.");return;}
            send(res,200,{job:recordJob(existing),idempotentReplay:true},cors);return;
          }
        }
        const id=randomUUID();
        db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json,idempotency_key) VALUES(?,?,?,?,'queued',?,?)")
          .run(id,user.id,projectId,type,inputJson,key||null);
        addJobEvent(db,id,user.id,"job.queued",{jobType:type});audit(db,user.id,"job.queued","job",id,{jobType:type},projectId);
        send(res,202,{job:recordJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(id))},cors);return;
      }
      const jobMatch=path.match(/^\/api\/jobs\/([0-9a-f-]+)(?:\/(cancel|events))?$/i);
      if(jobMatch){
        const job=accessibleJob(user.id,jobMatch[1],jobMatch[2]==="cancel");if(!job){fail(res,404,"JOB_NOT_FOUND","Job not found.");return;}
        if(jobMatch[2]==="cancel"&&req.method==="POST"){
          if(["succeeded","failed","cancelled"].includes(job.status)){fail(res,409,"JOB_TERMINAL","This job has already finished.");return;}
          db.prepare("UPDATE jobs SET status='cancelled',updated_at=?,completed_at=? WHERE id=?").run(now(),now(),job.id);
          addJobEvent(db,job.id,user.id,"job.cancelled",{});
          const active=activeProcesses.get(job.id);
          if(active&&!active.killed)active.kill("SIGTERM");
          send(res,200,{ok:true},cors);return;
        }
        if(jobMatch[2]==="events"&&req.method==="GET"){
          const events=db.prepare("SELECT id,event_type,event_json,created_at FROM job_events WHERE job_id=? ORDER BY id ASC").all(job.id);
          send(res,200,{events:events.map(x=>({id:x.id,type:x.event_type,data:parseJson(x.event_json),createdAt:x.created_at}))},cors);return;
        }
        if(!jobMatch[2]&&req.method==="GET"){
          const events=db.prepare("SELECT id,event_type,event_json,created_at FROM job_events WHERE job_id=? AND owner_id=? ORDER BY id ASC").all(job.id,user.id);
          send(res,200,{job:recordJob(job),events:events.map(x=>({id:x.id,type:x.event_type,data:parseJson(x.event_json),createdAt:x.created_at}))},cors);return;
        }
      }

      if(path==="/api/reviews"&&req.method==="GET"){
        const projectId=url.searchParams.get("projectId");
        if(projectId&&!getProjectAccess(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        const rows=projectId
          ? db.prepare("SELECT * FROM reviews WHERE project_id=? ORDER BY created_at DESC").all(projectId)
          : db.prepare("SELECT * FROM reviews WHERE (project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY created_at DESC LIMIT 200").all(user.id,user.id,user.id);
        send(res,200,{reviews:rows},cors);return;
      }
      if(path==="/api/reviews"&&req.method==="POST"){
        const body=await readJson(req),projectId=String(body.projectId||"");
        const access=getProjectAccess(db,user.id,projectId);
        if(!access){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        if(!["owner","editor","reviewer"].includes(access.access_role)){fail(res,403,"REVIEWER_REQUIRED","Reviewer permission is required to comment or approve.");return;}
        const text=String(body.body||"").trim(),decision=String(body.decision||"comment");
        if(!text||text.length>10000){fail(res,400,"INVALID_REVIEW","Review text must contain 1 to 10,000 characters.");return;}
        if(!["comment","approve","request_changes"].includes(decision)){fail(res,400,"INVALID_DECISION","Choose comment, approve or request_changes.");return;}
        const timecode=body.timecodeSeconds===undefined||body.timecodeSeconds===null?null:Number(body.timecodeSeconds);
        if(timecode!==null&&(!Number.isFinite(timecode)||timecode<0)){fail(res,400,"INVALID_TIMECODE","Review timecode must be a non-negative number.");return;}
        const assetId=body.assetId||null;
        if(assetId){const asset=getAccessibleAsset(db,user.id,String(assetId));if(!asset||asset.project_id&&asset.project_id!==projectId){fail(res,404,"ASSET_NOT_FOUND","Review asset is not accessible in this project.");return;}}
        const id=randomUUID(),status=decision==="approve"?"resolved":"open";
        db.prepare("INSERT INTO reviews(id,owner_id,project_id,asset_id,reviewer_id,timecode_seconds,decision,body,status,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(id,user.id,projectId,assetId,decision==="comment"?null:user.id,timecode,decision,text,status,status==="resolved"?now():null);
        audit(db,user.id,"review.created","review",id,{decision,timecodeSeconds:timecode},projectId);
        send(res,201,{review:{id,projectId,assetId,decision,body:text,status,timecodeSeconds:timecode,createdAt:now()}},cors);return;
      }
      const reviewMatch=path.match(/^\/api\/reviews\/([0-9a-f-]+)$/i);
      if(reviewMatch){
        const review=db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewMatch[1]);
        if(!review||!getProjectAccess(db,user.id,review.project_id)){fail(res,404,"REVIEW_NOT_FOUND","Review not found.");return;}
        const access=getProjectAccess(db,user.id,review.project_id);
        if(req.method==="PUT"){
          if(!["owner","editor","reviewer"].includes(access.access_role)){fail(res,403,"REVIEWER_REQUIRED","Reviewer permission is required to update review status.");return;}
          const body=await readJson(req),status=String(body.status||"");
          if(!["open","resolved","dismissed"].includes(status)){fail(res,400,"INVALID_REVIEW_STATUS","Choose open, resolved or dismissed.");return;}
          db.prepare("UPDATE reviews SET status=?,resolved_at=? WHERE id=?").run(status,status==="open"?null:now(),review.id);
          audit(db,user.id,"review.status_changed","review",review.id,{status},review.project_id);
          send(res,200,{ok:true,status},cors);return;
        }
      }
      if(path==="/api/audit"&&req.method==="GET"){
        const rows=db.prepare("SELECT id,project_id,event_type,subject_type,subject_id,details_json,created_at FROM audit_events WHERE (project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY id DESC LIMIT 200").all(user.id,user.id,user.id);
        send(res,200,{events:rows.map(x=>({id:x.id,projectId:x.project_id,type:x.event_type,subjectType:x.subject_type,subjectId:x.subject_id,details:parseJson(x.details_json),createdAt:x.created_at}))},cors);return;
      }
      fail(res,404,"NOT_FOUND","API route not found.");
    } catch(error) {
      process.stderr.write("API request failed: "+String(error.stack||error)+"\n");
      fail(res,error.status||500,error.code||"INTERNAL_ERROR",error.status?error.message:"The request could not be completed.");
    }
  });
}

if (AUTH_MODE==="local"&&process.env.NODE_ENV==="production") {
  throw new Error("AUTH_MODE=local is development-only. Configure AUTH_MODE=supabase and a publishable key before production.");
}
if (AUTH_MODE==="supabase"&&(!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY||!process.env.SUPABASE_SESSION_SECRET)) {
  throw new Error("Supabase authentication requires SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SESSION_SECRET.");
}
if (process.env.NODE_ENV!=="test") {
  const server=createAppServer();
  server.listen(PORT,HOST,()=>process.stdout.write(`Executive Visuals API listening on http://${HOST}:${PORT}\n`));
  const shutdown=()=>{if(workerTimer)clearInterval(workerTimer);for(const child of activeProcesses.values())if(!child.killed)child.kill("SIGTERM");server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
  process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
}
