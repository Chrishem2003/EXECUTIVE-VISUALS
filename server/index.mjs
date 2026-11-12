import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, unlink, open, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, basename, sep, relative, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { tmpdir } from "node:os";
import { openDatabase, audit, addJobEvent, getOwnedProject, getOwnedAsset, getProjectAccess, canWriteProject, getAccessibleAsset, json, parseJson } from "./db.mjs";
import { executeMediaJob, executableAvailable } from "./media.mjs";
import { createRealEsrganAdapter } from "./ai-upscale-engine.mjs";
import { loadUpscaleQualityEvidence } from "./upscale-quality-evidence.mjs";
import { validateWorkflowGraph, planWorkflowTarget } from "./workflow-validation.mjs";
import { validateTimelineDocument } from "./timeline-validation.mjs";
import { executeWorkflowRun } from "./workflow-executor.mjs";
import { resumeCompletedCloudVideoWorkflows } from "./workflow-cloud-video-resumer.mjs";
import { claimNextJob, completeJob, recoverExpiredJobs, renewJobLease } from "./queue.mjs";
import { createCloudQueue } from "./cloud-queue.mjs";
import { sanitizeCreativeWorkspaceDocument } from "./workspace-documents.mjs";
import { importResearchUrl } from "./research-import.mjs";
import { getProviderCatalog } from "./provider-registry.mjs";
import { buildAdminProviderReadiness, buildAdminProviderReadinessSummary } from "./admin-operations.mjs";
import { getProviderCapabilityAtlas } from "./provider-capability-atlas.mjs";
import { estimateVideoGenerationCost, estimateVideoProductionCost, parseVideoPricingCatalog } from "./video-cost-estimator.mjs";
import { preflightVideoProduction } from "./video-shot-preflight.mjs";
import { buildVideoGenerationApproval } from "./video-generation-approval.mjs";
import { ensureRemoteUsageTable, getRemoteUsagePolicy } from "./usage-guardrails.mjs";
import { createCloudTimelineApi } from "./cloud-timeline-api.mjs";
import { createCloudVideoGenerationRepositories } from "./cloud-video-generation-repositories.mjs";
import { createCloudVideoGenerationDispatch } from "./cloud-video-generation-dispatch.mjs";
import { validateSrt, validateWebVtt } from "./caption-validation.mjs";
import { createAssetProvenanceRecord, verifyAssetProvenanceRecord } from "./provenance.mjs";
import { verifyC2paAsset } from "./c2pa-verification.mjs";
import { ensureTransformationPlanSchema, createTransformationPlan, approveTransformationPlan, listTransformationPlans, getTransformationPlan } from "./transformation-plans.mjs";
import { signInWithSupabasePassword, signUpWithSupabasePassword, refreshSupabaseSession, getSupabaseUser, revokeSupabaseSession, requestSupabasePasswordRecovery, updateSupabasePassword, isSupabaseRecoveryToken } from "./supabase-password-auth.mjs";
import { createSupabaseSessionStore, assertSameOriginMutation } from "./supabase-session-store.mjs";
import { createSupabaseSessionRefreshCoordinator } from "./supabase-session-refresh.mjs";
import { createFinancialIntelligenceApi } from "./financial-intelligence-api.mjs";
import { createControlRemediationApi } from "./control-remediation-api.mjs";
import { isPlatformAdministrator, getAdminOperationsOverview, listAdminOperationUsers, listAdminOperationJobs, listAdminOperationAudit, buildVideoDispatchReadiness } from "./admin-operations.mjs";

const PORT = Number(process.env.PORT || process.env.API_PORT || 4179);
const HOST = process.env.API_HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const AUTH_MODE = process.env.AUTH_MODE || "local";
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT || join(DATA_DIR, "media"));
const WEB_ROOT = resolve(process.env.WEB_ROOT || "./dist");
const DB_FILE = resolve(process.env.DB_FILE || join(DATA_DIR, "executive-visuals.sqlite"));
const REQUIRE_PERSISTENT_DATA_DIR = process.env.REQUIRE_PERSISTENT_DATA_DIR === "true";
// Persistence is an operator assertion, not something inferred from a non-/tmp path.
const tempRelative = relative(resolve(tmpdir()), DATA_DIR);
const dataDirIsEphemeral = tempRelative === "" || (tempRelative !== ".." && !tempRelative.startsWith(".." + sep) && !isAbsolute(tempRelative));
const DATA_DIR_PERSISTENCE = process.env.DATA_DIR_PERSISTENCE === "persistent-volume" ? "operator-confirmed-volume" : dataDirIsEphemeral ? "ephemeral" : "unverified";
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
const supabaseSessionStore = process.env.SUPABASE_SESSION_ENCRYPTION_KEY ? createSupabaseSessionStore({ db, encryptionKey: process.env.SUPABASE_SESSION_ENCRYPTION_KEY }) : null;
const supabaseSessionRefresh = supabaseSessionStore ? createSupabaseSessionRefreshCoordinator({store:supabaseSessionStore,refreshSession:refreshSupabaseSession,getUser:getSupabaseUser}) : null;
const controlRemediationApi = createControlRemediationApi({db});
ensureTransformationPlanSchema(db);
const aiUpscaleAdapter = createRealEsrganAdapter();
const financialApiEnabled = process.env.BILLING_API_ENABLED === "true";
if (financialApiEnabled && AUTH_MODE !== "supabase") throw new Error("Financial intelligence API requires verified Supabase authentication.");
const financialApi = financialApiEnabled ? createFinancialIntelligenceApi() : null;
const paymentReconciliationIntervalMinutes = Math.max(5,Math.min(1440,Number(process.env.PAYMENT_RECONCILIATION_INTERVAL_MINUTES)||60));
let paymentReconciliationBusy=false;
const paymentReconciliationTimer = financialApi && process.env.PAYMENT_RECONCILIATION_ENABLED !== "false"
  ? setInterval(async()=>{
      if(paymentReconciliationBusy)return;
      paymentReconciliationBusy=true;
      try{
        const result=await financialApi.reconcilePendingRefunds({limit:100});
        if(result.checked)process.stdout.write("Financial reconciliation checked "+result.checked+" pending refund(s).\\n");
      }catch(error){
        process.stderr.write("Financial reconciliation cycle failed: "+String(error.message||"unknown error")+"\\n");
      }finally{paymentReconciliationBusy=false;}
    },paymentReconciliationIntervalMinutes*60_000)
  : null;

paymentReconciliationTimer?.unref();
const subscriptionLifecycleIntervalMinutes=Math.max(5,Math.min(1440,Number(process.env.SUBSCRIPTION_LIFECYCLE_INTERVAL_MINUTES)||15));
let subscriptionLifecycleBusy=false;
const subscriptionLifecycleTimer=financialApi&&process.env.SUBSCRIPTION_LIFECYCLE_ENABLED!=="false"
  ?setInterval(async()=>{
    if(subscriptionLifecycleBusy)return;
    subscriptionLifecycleBusy=true;
    try{
      const result=await financialApi.expireDueSubscriptions();
      if(Number(result?.expiredCount)>0)process.stdout.write("Subscription lifecycle finalized "+result.expiredCount+" expired subscription(s), including "+(result.scheduledCancellationsFinalized||0)+" scheduled cancellation(s).\\n");
    }catch(error){
      process.stderr.write("Subscription lifecycle cycle failed: "+String(error.message||"unknown error")+"\\n");
    }finally{subscriptionLifecycleBusy=false;}
  },subscriptionLifecycleIntervalMinutes*60_000)
  :null;
subscriptionLifecycleTimer?.unref();
const cloudTimelineApiEnabled = process.env.CLOUD_TIMELINE_API_ENABLED === "true";
if (cloudTimelineApiEnabled && AUTH_MODE !== "supabase") throw new Error("Cloud timeline API requires verified Supabase authentication.");
const cloudTimelineApi = cloudTimelineApiEnabled ? createCloudTimelineApi({maxUploadBytes:Number(process.env.CLOUD_MEDIA_MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES),env:process.env}) : null;
if (cloudTimelineApi) await cloudTimelineApi.checkReadiness();
const cloudVideoGenerationDispatchEnabled=process.env.CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED==="true";
if(cloudVideoGenerationDispatchEnabled&&!cloudTimelineApiEnabled)throw new Error("Cloud video generation dispatch requires CLOUD_TIMELINE_API_ENABLED=true for authenticated job progress and asset access.");
if(cloudVideoGenerationDispatchEnabled&&AUTH_MODE!=="supabase")throw new Error("Cloud video generation dispatch requires verified Supabase authentication.");
if(cloudVideoGenerationDispatchEnabled&&(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY))throw new Error("Cloud video generation dispatch requires server-side Supabase credentials.");
const cloudVideoGenerationDispatch=cloudVideoGenerationDispatchEnabled?createCloudVideoGenerationDispatch({
 db,queue:createCloudQueue(),repositories:createCloudVideoGenerationRepositories(),canWriteProject:(ownerId,projectId)=>canWriteProject(db,ownerId,projectId),
 audit:(ownerId,...args)=>audit(db,ownerId,...args)
}):null;
const activeProcesses = new Map();
const WORKER_ID = randomUUID();
const rateBuckets = new Map();
const AUTH_RATE_LIMIT = Math.max(1, Math.min(1000, Number(process.env.AUTH_RATE_LIMIT) || 20));
function rateAllowed(key,limit,windowMs){const time=Date.now();const old=rateBuckets.get(key);if(!old||time-old.start>=windowMs){rateBuckets.set(key,{start:time,count:1});return true;}old.count++;return old.count<=limit;}
await mkdir(join(MEDIA_ROOT,"uploads"), { recursive:true });
await mkdir(join(MEDIA_ROOT,"derived"), { recursive:true });

const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const stableJson = value => Array.isArray(value) ? "["+value.map(stableJson).join(",")+"]" : value && typeof value==="object" ? "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stableJson(value[key])).join(",")+"}" : JSON.stringify(value);
const safeName = value => basename(String(value || "upload")).replace(/[\u0000-\u001f\u007f]/g,"").replace(/[^\p{L}\p{N}._() -]/gu,"_").slice(0,180) || "upload";
const SECURITY_HEADERS = {
  "x-content-type-options":"nosniff",
  "x-frame-options":"DENY",
  "referrer-policy":"strict-origin-when-cross-origin",
  "cross-origin-opener-policy":"same-origin",
  "cross-origin-resource-policy":"same-origin",
  "permissions-policy":"camera=(), microphone=(), geolocation=()"
};
const CLOUD_MEDIA_ORIGIN = (()=>{try{const value=new URL(process.env.SUPABASE_URL||"");return value.protocol==="https:"&&!value.username&&!value.password?value.origin:"";}catch{return "";}})();
const HTML_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: "+CLOUD_MEDIA_ORIGIN+"; media-src 'self' blob: "+CLOUD_MEDIA_ORIGIN+"; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const send = (res,status,body,headers={}) => { res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...SECURITY_HEADERS,...headers});res.end(JSON.stringify(body)); };
const fail = (res,status,code,message) => send(res,status,{error:{code,message}});
const readRawBody = async (req,limit=1024*1024) => {
  const chunks=[];let size=0;
  for await (const chunk of req) { size+=chunk.length;if(size>limit)throw Object.assign(new Error("Request body too large."),{status:413,code:"BODY_TOO_LARGE"});chunks.push(chunk); }
  return Buffer.concat(chunks);
};
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
function createLocalSession(userId) {
  const token=randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .run(hash(token),userId,new Date(Date.now()+SESSION_DAYS*86400000).toISOString());
  return token;
}
function setSupabaseSessionCookies(res,token,maxAge=30*86400){
 const secure=process.env.NODE_ENV==="production"||process.env.COOKIE_SECURE==="true"?"; Secure":"";
 res.setHeader("set-cookie",["ev_supabase_session="+encodeURIComponent(token)+"; HttpOnly; SameSite=Strict; Path=/; Max-Age="+maxAge+secure,"ev_supabase_access=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+secure,"ev_supabase_refresh=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+secure]);
}
function clearSupabaseSessionCookies(res){
 const secure=process.env.NODE_ENV==="production"||process.env.COOKIE_SECURE==="true"?"; Secure":"";
 res.setHeader("set-cookie",["ev_supabase_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+secure,"ev_supabase_access=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+secure,"ev_supabase_refresh=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"+secure]);
}
function createSupabaseBrowserSession(session){
 if(!supabaseSessionStore)throw Object.assign(new Error("Supabase browser sessions require SUPABASE_SESSION_ENCRYPTION_KEY (32 random bytes)."),{code:"SUPABASE_SESSION_ENCRYPTION_NOT_CONFIGURED",status:503});
 db.prepare("INSERT INTO users(id,email,auth_source) VALUES(?,?, 'supabase') ON CONFLICT(id) DO UPDATE SET email=excluded.email,auth_source=excluded.auth_source").run(session.user.id,session.user.email||session.user.id+"@supabase.invalid");
 return supabaseSessionStore.create({userId:session.user.id,accessToken:session.accessToken,refreshToken:session.refreshToken,expiresIn:session.expiresIn});
}
async function authenticate(req,res) {
 if (AUTH_MODE === "supabase") {
  if(!supabaseSessionStore)throw Object.assign(new Error("Supabase browser sessions are not configured. Set SUPABASE_SESSION_ENCRYPTION_KEY."),{code:"SUPABASE_SESSION_ENCRYPTION_NOT_CONFIGURED",status:503});
  const config={supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY};
  const browserToken=cookieValue(req,"ev_supabase_session");
  if(!browserToken){if(cookieValue(req,"ev_supabase_access")||cookieValue(req,"ev_supabase_refresh"))clearSupabaseSessionCookies(res);return null;}
  let stored=supabaseSessionStore.get(browserToken);
  if(!stored){clearSupabaseSessionCookies(res);return null;}
  let user=await getSupabaseUser({...config,accessToken:stored.accessToken});
  if(user&&user.id!==stored.userId){supabaseSessionStore.delete(browserToken);clearSupabaseSessionCookies(res);return null;}
  if(!user){
   const refreshed=await supabaseSessionRefresh.refresh({token:browserToken,config});
   if(!refreshed){supabaseSessionStore.delete(browserToken);clearSupabaseSessionCookies(res);return null;}
   stored=refreshed.stored;user=refreshed.user;
  }
  if(!user||user.id!==stored.userId)return null;
  db.prepare("INSERT INTO users(id,email,auth_source) VALUES(?,?, 'supabase') ON CONFLICT(id) DO UPDATE SET email=excluded.email,auth_source=excluded.auth_source").run(user.id,user.email||user.id+"@supabase.invalid");
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
  const createdAt=now();
  const provenance=createAssetProvenanceRecord({asset:{id,sha256,mediaType,size},createdAt});
  const metadata={
    ...((extension===".srt"&&(mediaType==="text/plain"||mediaType==="application/x-subrip"))?{captionValidation:validateSrt(await readFile(absolute,"utf8"))}:extension===".vtt"&&mediaType==="text/vtt"?{captionValidation:validateWebVtt(await readFile(absolute,"utf8"))}:{}),
    provenance
  };
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id,user.id,projectId||null,originalName,mediaType,size,sha256,relative,json(metadata),createdAt);
  audit(db,user.id,"asset.uploaded","asset",id,{name:originalName,mediaType,size,sha256,provenanceHash:provenance.recordHash},projectId||null);
  return {id,projectId:projectId||null,name:originalName,mediaType,size,sha256,provenance,createdAt};
}
async function processNextJob() {
  recoverExpiredJobs(db);
  const current=claimNextJob(db,WORKER_ID);
  if(!current)return;
  const job=current;
  addJobEvent(db,job.id,job.owner_id,"job.started",{attempt:current.attempt_count,workerLease:true});
  let leaseLost=false;
  const resourceMeasurements=[];
  const flushResourceMeasurements=async()=>{
    if(!financialApi||process.env.RESOURCE_COST_METERING_ENABLED!=="true"||!resourceMeasurements.length)return;
    const pending=resourceMeasurements.splice(0,resourceMeasurements.length);
    for(const measurement of pending){
      try{await financialApi.recordWorkerWorkloadTelemetry({job,measurement});}
      catch(error){process.stderr.write("Workload telemetry could not be recorded for job "+job.id+": "+String(error.message||error)+"\\n");}
      try{await financialApi.recordWorkerResourceUsage({job,measurement});}
      catch(error){process.stderr.write("Resource cost telemetry could not be recorded for job "+job.id+": "+String(error.message||error)+"\\n");}
    }
  };
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
      db,job:current,mediaRoot:MEDIA_ROOT,activeProcesses,cloudTimelineApi,
      onResourceMeasurement:value=>{if(value&&typeof value==="object")resourceMeasurements.push(value);},
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
    if(current.job_type==="workflow.execute"&&result?.status==="blocked"){
      const runId=String(parseJson(current.input_json,{}).runId||"");
      const workflowError=runId?db.prepare("SELECT error_json FROM workflow_runs WHERE id=?").get(runId):null;
      const details=parseJson(workflowError?.error_json,{code:"WORKFLOW_BLOCKED",message:"Workflow is waiting for an external job."});
      const changed=db.prepare("UPDATE jobs SET status='blocked',output_json=?,error_json=?,updated_at=?,completed_at=?,available_at=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE id=? AND status='running' AND lease_owner=? AND lease_expires_at>?")
        .run(json(result),json(details),now(),now(),job.id,WORKER_ID,now());
      if(changed.changes===1){
        addJobEvent(db,job.id,job.owner_id,"job.blocked",details);
        audit(db,job.owner_id,"job.blocked","job",job.id,{jobType:job.job_type,runId},job.project_id);
      }
    }else if(completeJob(db,job.id,WORKER_ID,result,now())){
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
    await flushResourceMeasurements();
    clearInterval(heartbeat);
  }
}
let workerBusy=false;
const workerTimer=process.env.DISABLE_WORKER==="true"?null:setInterval(async()=>{if(workerBusy)return;workerBusy=true;try{await processNextJob();}catch(error){process.stderr.write("Worker cycle failed: "+String(error.message)+"\\n");}finally{workerBusy=false;}},500);
workerTimer?.unref();
let cloudWorkflowResumeBusy=false;
const cloudWorkflowResumeTimer=cloudTimelineApi&&process.env.DISABLE_WORKER!=="true"?setInterval(async()=>{
 if(cloudWorkflowResumeBusy)return;
 cloudWorkflowResumeBusy=true;
 try{await resumeCompletedCloudVideoWorkflows({db,cloudTimelineApi,onError:error=>process.stderr.write("Cloud workflow resume check failed: "+String(error?.code||error?.message||"RESUME_FAILED")+"\\n")});}
 catch(error){process.stderr.write("Cloud workflow resume cycle failed: "+String(error?.code||error?.message||"RESUME_FAILED")+"\\n");}
 finally{cloudWorkflowResumeBusy=false;}
},5000):null;
cloudWorkflowResumeTimer?.unref();

export function createAppServer() {
  return createServer(async(req,res)=>{
    const cors=originHeaders(req);
    if(cors===null){fail(res,403,"ORIGIN_DENIED","Request origin is not allowed.");return;}
    if(req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-methods":"GET,POST,PUT,DELETE,OPTIONS","access-control-allow-headers":"content-type,authorization,x-file-name,x-project-id,idempotency-key","access-control-max-age":"600",...cors});res.end();return;}
    const url=new URL(req.url||"/","http://localhost");
    const path=url.pathname;
    if(AUTH_MODE==="supabase"&&!["GET","HEAD","OPTIONS"].includes(req.method)&&path!=="/api/webhooks/flutterwave"){
      const forwardedProto=String(req.headers["x-forwarded-proto"]||"").split(",")[0].trim();
      const scheme=forwardedProto==="https"||req.socket.encrypted?"https":"http";
      try{
        const expectedOrigin=process.env.PUBLIC_APP_URL?new URL(process.env.PUBLIC_APP_URL).origin:scheme+"://"+String(req.headers.host||"");
        assertSameOriginMutation({origin:req.headers.origin,expectedOrigin,secFetchSite:req.headers["sec-fetch-site"]});
      }catch(error){fail(res,error.status||403,error.code||"CSRF_ORIGIN_DENIED",error.message);return;}
    }
    const ratePath=path==="/api/auth/recover"?"/auth-recover":path.startsWith("/api/auth/")?"/auth":(path==="/api/assets"||path==="/api/cloud/assets")&&req.method==="POST"?"/upload":path.endsWith("/research/import")&&req.method==="POST"?"/research":path==="/api/admin/ai-upscale/self-test"&&req.method==="POST"?"/ai-upscale-self-test":"";
    if(ratePath){const key=(req.socket.remoteAddress||"unknown")+ratePath;const limit=ratePath==="/auth-recover"?3:ratePath==="/auth"?AUTH_RATE_LIMIT:ratePath==="/research"?10:ratePath==="/ai-upscale-self-test"?2:30;const rateWindow=ratePath==="/auth-recover"?3600000:60000;if(!rateAllowed(key,limit,rateWindow)){fail(res,429,"RATE_LIMITED","Too many requests. Wait before trying again.");return;}}
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
        send(res,200,{status:"ok",storage:"local-disk",database:"sqlite",persistence:{dataDirectory:DATA_DIR_PERSISTENCE,persistentVolumeRequired:REQUIRE_PERSISTENT_DATA_DIR},media:{ffmpeg:executableAvailable("ffmpeg"),ffprobe:executableAvailable("ffprobe")},imageGateway:{enabled:process.env.IMAGE_GATEWAY_ENABLED==="true",configured:(()=>{const provider=String(process.env.IMAGE_GATEWAY_PROVIDER||"openai-compatible").toLowerCase();if(provider==="gemini")return Boolean(process.env.GEMINI_API_KEY&&process.env.GEMINI_IMAGE_MODEL&&process.env.IMAGE_GATEWAY_ALLOW_REMOTE==="true");if(provider==="fal")return Boolean(process.env.FAL_KEY&&process.env.FAL_IMAGE_MODEL&&process.env.IMAGE_GATEWAY_ALLOW_REMOTE==="true");try{const url=new URL(process.env.IMAGE_GATEWAY_URL||"");const local=["localhost","127.0.0.1","::1"].includes(url.hostname.toLowerCase());return Boolean(process.env.IMAGE_GATEWAY_MODEL&&(local||process.env.IMAGE_GATEWAY_ALLOW_REMOTE==="true"));}catch{return false;}})()},textGateway:{enabled:process.env.AI_GATEWAY_ENABLED==="true",configured:(()=>{try{const url=new URL(process.env.AI_GATEWAY_URL||"");const local=["localhost","127.0.0.1","::1"].includes(url.hostname.toLowerCase());return Boolean(process.env.AI_GATEWAY_MODEL&&(local||process.env.AI_GATEWAY_ALLOW_REMOTE==="true"));}catch{return false;}})()},authMode:AUTH_MODE,authSession:{opaqueCookie:true,encryptedServerTokens:Boolean(supabaseSessionStore),configurationReady:AUTH_MODE!=="supabase"||Boolean(supabaseSessionStore)},cloudMedia:{enabled:Boolean(cloudTimelineApi),ready:Boolean(cloudTimelineApi)},billing:{enabled:financialApiEnabled,refundsEnabled:financialApiEnabled&&process.env.FLW_REFUNDS_ENABLED==="true",provider:process.env.FLW_API_BASE_URL==="https://f4bexperience.flutterwave.com"?"live":"sandbox",providerKeyConfigured:Boolean(process.env.FLW_CLIENT_ID&&process.env.FLW_CLIENT_SECRET),webhookSecretConfigured:Boolean(process.env.FLW_SECRET_HASH)},version:"0.1.0"},cors);return;
      }
      if(path==="/api/auth/recover"&&req.method==="POST"){
        if(AUTH_MODE!=="supabase"){fail(res,501,"PASSWORD_RECOVERY_UNAVAILABLE","Password recovery is available only when Supabase authentication is configured.");return;}const publicAppUrl=String(process.env.PUBLIC_APP_URL||"").trim();if(!publicAppUrl){fail(res,503,"PASSWORD_RECOVERY_NOT_CONFIGURED","Password recovery needs PUBLIC_APP_URL and an exact matching Supabase Auth redirect URL.");return;}let redirect;try{redirect=new URL(publicAppUrl);}catch{fail(res,503,"PASSWORD_RECOVERY_NOT_CONFIGURED","PUBLIC_APP_URL is not a valid absolute URL.");return;}const localRedirect=process.env.NODE_ENV!=="production"&&["localhost","127.0.0.1","::1"].includes(redirect.hostname);if((redirect.protocol!=="https:"&&!localRedirect)||redirect.username||redirect.password||redirect.search||redirect.hash||redirect.pathname!=="/"){fail(res,503,"PASSWORD_RECOVERY_NOT_CONFIGURED","PUBLIC_APP_URL must be an HTTPS site origin ending in /, without credentials, query parameters or fragments.");return;}const body=await readJson(req);await requestSupabasePasswordRecovery({supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY,email:String(body.email||""),redirectTo:redirect.origin+"/"});send(res,200,{ok:true,message:"If an account exists for that address, a password recovery email has been sent."},cors);return;
      }
      if(path==="/api/auth/password"&&req.method==="PUT"){
        if(AUTH_MODE!=="supabase"){fail(res,501,"PASSWORD_RECOVERY_UNAVAILABLE","Password recovery is available only when Supabase authentication is configured.");return;}const accessToken=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(!accessToken){fail(res,401,"RECOVERY_SESSION_REQUIRED","Open the password recovery link from your email before choosing a new password.");return;}const config={supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY};const recoveryUser=await getSupabaseUser({...config,accessToken});if(!recoveryUser||!isSupabaseRecoveryToken({accessToken,userId:recoveryUser.id,supabaseUrl:config.supabaseUrl})){fail(res,401,"RECOVERY_SESSION_INVALID","This password recovery link is invalid or expired. Request a new one.");return;}const body=await readJson(req);const updated=await updateSupabasePassword({...config,accessToken,password:String(body.password||"")});send(res,200,{ok:true,user:updated.user},cors);return;
      }
      if(path==="/api/auth/register"&&req.method==="POST"){
        const body=await readJson(req);const email=String(body.email||"").trim().toLowerCase();const password=String(body.password||"");
        if(AUTH_MODE==="supabase"){
          const result=await signUpWithSupabasePassword({supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY,email,password});
          if(result.confirmationRequired){send(res,202,{confirmationRequired:true,user:result.user,authMode:"supabase"},cors);return;}
          const stored=createSupabaseBrowserSession(result);setSupabaseSessionCookies(res,stored.token,stored.expiresIn);send(res,201,{user:result.user,authMode:"supabase"},cors);return;
        }
        if(AUTH_MODE!=="local"||process.env.NODE_ENV==="production"){fail(res,403,"REGISTRATION_DISABLED","Local account registration is disabled in this environment.");return;}
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12){fail(res,400,"INVALID_CREDENTIALS","Enter a valid email and a password of at least 12 characters.");return;}
        const id=randomUUID(),salt=randomBytes(16).toString("hex"),passwordHash=scryptSync(password,salt,64).toString("hex");
        try{db.prepare("INSERT INTO users(id,email,password_hash,password_salt) VALUES(?,?,?,?)").run(id,email,passwordHash,salt);}
        catch{fail(res,409,"ACCOUNT_EXISTS","An account with this email already exists.");return;}
        const token=createLocalSession(id);setCookie(res,token,SESSION_DAYS*86400);audit(db,id,"account.created","user",id,{authMode:"local"});
        send(res,201,{user:{id,email},authMode:"local"},cors);return;
      }
      if(path==="/api/auth/login"&&req.method==="POST"){
        const body=await readJson(req);const email=String(body.email||"").trim().toLowerCase();const password=String(body.password||"");
        if(AUTH_MODE==="supabase"){
          const session=await signInWithSupabasePassword({supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY,email,password});
          const stored=createSupabaseBrowserSession(session);setSupabaseSessionCookies(res,stored.token,stored.expiresIn);send(res,200,{user:session.user,authMode:"supabase"},cors);return;
        }
        if(AUTH_MODE!=="local"){fail(res,403,"USE_EXTERNAL_AUTH","Sign in through the configured identity provider.");return;}
        if(password.length===0||password.length>256){fail(res,401,"INVALID_CREDENTIALS","Email or password is incorrect.");return;}
        const user=db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email);
        const candidate=user?scryptSync(password,user.password_salt,64).toString("hex"):"";
        const valid=!!user&&candidate.length===user.password_hash.length&&timingSafeEqual(Buffer.from(candidate,"hex"),Buffer.from(user.password_hash,"hex"));
        if(!valid){fail(res,401,"INVALID_CREDENTIALS","Email or password is incorrect.");return;}
        const token=createLocalSession(user.id);setCookie(res,token,SESSION_DAYS*86400);
        send(res,200,{user:{id:user.id,email:user.email},authMode:"local"},cors);return;
      }
      if(path==="/api/auth/logout"&&req.method==="POST"){
        const localToken=cookieValue(req,"ev_session");if(localToken)db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(localToken));
        if(AUTH_MODE==="supabase"){
          const browserToken=cookieValue(req,"ev_supabase_session");
          const stored=supabaseSessionStore?.get(browserToken);
          if(stored?.accessToken)await revokeSupabaseSession({supabaseUrl:process.env.SUPABASE_URL,publishableKey:process.env.SUPABASE_PUBLISHABLE_KEY,accessToken:stored.accessToken});
          supabaseSessionStore?.delete(browserToken);
          clearSupabaseSessionCookies(res);
        }else setCookie(res,"",0);
        send(res,200,{ok:true},cors);return;
      }
      if(path==="/api/webhooks/flutterwave"&&req.method==="POST"){
        if(!financialApi){fail(res,503,"BILLING_DISABLED","Flutterwave webhooks are disabled until financial staging is enabled.");return;}
        const rawBody=await readRawBody(req,1024*1024);
        const webhookResult=await financialApi.handleWebhook({rawBody,signatureV4:String(req.headers["flutterwave-signature"]||""),signatureV3:String(req.headers["verif-hash"]||"")});
        send(res,webhookResult.status,webhookResult.body,cors);return;
      }
      const user=await authenticate(req,res);
      if(!user){fail(res,401,"AUTH_REQUIRED","Sign in to access this workspace.");return;}
      if(path==="/api/me"&&req.method==="GET"){send(res,200,{user,authMode:AUTH_MODE,capabilities:{admin:isPlatformAdministrator(user)}},cors);return;}
      if(path==="/api/d1"||path.startsWith("/api/d1/")){
        const configuredWorker=String(process.env.D1_STAGING_WORKER_URL||"").trim();
        if(!configuredWorker){fail(res,503,"D1_STAGING_DISABLED","The isolated D1 staging bridge is not enabled in this environment.");return;}
        let workerOrigin;
        try{
          workerOrigin=new URL(configuredWorker);
          const localDevelopment=process.env.NODE_ENV!=="production"&&["localhost","127.0.0.1"].includes(workerOrigin.hostname);
          if((workerOrigin.protocol!=="https:"&&!localDevelopment)||workerOrigin.username||workerOrigin.password||workerOrigin.pathname!=="/"||workerOrigin.search||workerOrigin.hash||(!localDevelopment&&!workerOrigin.hostname.endsWith(".workers.dev"))){
            throw new Error("D1 staging URL is not an approved HTTPS Worker origin.");
          }
        }catch{
          fail(res,503,"D1_STAGING_CONFIG_INVALID","The isolated D1 staging Worker URL is invalid.");return;
        }
        if(!["GET","POST","PATCH","PUT"].includes(req.method)){fail(res,405,"D1_METHOD_NOT_ALLOWED","This staging endpoint does not support the requested method.");return;}
        try{
          const headers=new Headers();
          for(const name of ["cookie","authorization","content-type","accept"]){
            const value=req.headers[name];
            if(typeof value==="string"&&value)headers.set(name,value);
          }
          let body;
          if(req.method!=="GET"&&req.method!=="HEAD"){
            const payload=await readJson(req,256*1024);
            body=JSON.stringify(payload);
            if(!headers.has("content-type"))headers.set("content-type","application/json");
          }
          const target=new URL(path+url.search,workerOrigin);
          const upstream=await fetch(new Request(target,{method:req.method,headers,body,redirect:"manual",signal:AbortSignal.timeout(15000)}));
          const payload=await upstream.json().catch(()=>null);
          if(payload===null){fail(res,502,"D1_STAGING_INVALID_RESPONSE","The staging Worker returned an invalid response.");return;}
          const cookies=typeof upstream.headers.getSetCookie==="function"?upstream.headers.getSetCookie():[upstream.headers.get("set-cookie")].filter(Boolean);
          send(res,upstream.status,payload,{...cors,...(cookies.length?{"set-cookie":cookies}:{})});return;
        }catch(error){
          fail(res,502,"D1_STAGING_UNAVAILABLE",error?.name==="TimeoutError"?"The staging Worker did not respond in time.":"The isolated D1 staging Worker could not be reached.");return;
        }
      }
      if(path.startsWith("/api/admin/operations/")){
        if(!isPlatformAdministrator(user)){fail(res,403,"ADMIN_REQUIRED","An explicitly allowlisted platform administrator is required.");return;}
        if(path==="/api/admin/operations/overview"&&req.method==="GET"){
          send(res,200,{overview:getAdminOperationsOverview(db,{authMode:AUTH_MODE,dataPersistence:DATA_DIR_PERSISTENCE,persistentDataRequired:REQUIRE_PERSISTENT_DATA_DIR})},cors);return;
        }
        if(path==="/api/admin/operations/users"&&req.method==="GET"){
          send(res,200,{users:listAdminOperationUsers(db,{query:String(url.searchParams.get("q")||""),limit:url.searchParams.get("limit")})},cors);return;
        }
        if(path==="/api/admin/operations/jobs"&&req.method==="GET"){
          send(res,200,{jobs:listAdminOperationJobs(db,{limit:url.searchParams.get("limit")})},cors);return;
        }
        if(path==="/api/admin/operations/providers"&&req.method==="GET"){
          const [modelProbes,qualityEvidence]=await Promise.all([Promise.all(["realesrgan-x4plus","realesrgan-x4plus-anime"].map(model=>aiUpscaleAdapter.probe(model))),loadUpscaleQualityEvidence()]);
          const upscaleModels=modelProbes.map(model=>({...model,qualityVerified:qualityEvidence.models[model.model]?.qualityVerified===true,qualityEvidence:qualityEvidence.models[model.model]?.qualityEvidence||null,qualityReason:qualityEvidence.models[model.model]?.reason||qualityEvidence.reason}));
          const aiUpscale={...upscaleModels[0],models:upscaleModels,qualityVerified:upscaleModels[0]?.qualityVerified===true,qualityEvidence:upscaleModels[0]?.qualityEvidence||null};
          const catalog=getProviderCatalog(process.env,{ffmpeg:executableAvailable("ffmpeg"),ffprobe:executableAvailable("ffprobe"),aiUpscale});
          const providers=buildAdminProviderReadiness(catalog);
          const generationReadiness=buildVideoDispatchReadiness({env:process.env,providerCatalog:catalog,dataPersistence:DATA_DIR_PERSISTENCE});
          send(res,200,{providers,summary:buildAdminProviderReadinessSummary(providers),generationReadiness,policy:{remoteCallsRequireExplicitOptIn:true,credentialsExposed:false,requestsSubmitted:false}},cors);return;
        }
        if(path==="/api/admin/operations/audit"&&req.method==="GET"){
          send(res,200,{events:listAdminOperationAudit(db,{limit:url.searchParams.get("limit")})},cors);return;
        }
        fail(res,404,"ADMIN_OPERATIONS_ROUTE_NOT_FOUND","Administrator operations route not found.");return;
      }
      if(path.startsWith("/api/finance/remediations")){
        const remediationBody=["POST","PATCH"].includes(req.method)?await readJson(req,64*1024):{};
        const remediationResult=await controlRemediationApi.handle({method:req.method,path,ownerId:user.id,body:remediationBody,query:Object.fromEntries(url.searchParams.entries())});
        if(remediationResult){send(res,remediationResult.status,remediationResult.body,cors);return;}
      }
      if(financialApi && (path.startsWith("/api/billing/")||path.startsWith("/api/admin/billing/")||path.startsWith("/api/admin/subscriptions/")||path.startsWith("/api/admin/finance/"))){
        const financialBody=req.method==="POST"?await readJson(req,64*1024):{};
        const financialResult=await financialApi.handle({method:req.method,path,ownerId:user.id,body:financialBody,query:Object.fromEntries(url.searchParams.entries()),idempotencyKey:String(req.headers["idempotency-key"]||"")});
        if(financialResult){send(res,financialResult.status,financialResult.body,cors);return;}
      }
      if(cloudTimelineApi && path==="/api/cloud/assets" && req.method==="POST"){
        const uploadResult=await cloudTimelineApi.uploadAsset({
          req,ownerId:user.id,projectId:String(req.headers["x-project-id"]||""),
          originalName:String(req.headers["x-file-name"]||"upload"),
          mediaType:String(req.headers["content-type"]||"application/octet-stream")
        });
        send(res,uploadResult.status,uploadResult.body,cors);return;
      }
      if(cloudTimelineApi && (path.startsWith("/api/cloud/timelines")||path.startsWith("/api/cloud/jobs")||path.startsWith("/api/cloud/assets")||path.startsWith("/api/cloud/projects")||path.startsWith("/api/cloud/transformations")||path.startsWith("/api/cloud/workflows")||path.startsWith("/api/cloud/reviews"))){
        const isCloudMutation=(path.startsWith("/api/cloud/reviews")&&(req.method==="POST"||req.method==="PATCH"))||(path.startsWith("/api/cloud/workflows")&&req.method==="POST")||(path.startsWith("/api/cloud/transformations")&&(req.method==="POST"||path.endsWith("/approve")&&req.method==="POST"||path.endsWith("/submit")&&req.method==="POST"))||(path.startsWith("/api/cloud/timelines")&&(req.method==="POST"||req.method==="PUT"))||(path==="/api/cloud/projects"&&req.method==="POST")||(path.startsWith("/api/cloud/projects/")&&(req.method==="PATCH"||req.method==="DELETE"));
        const body=isCloudMutation?await readJson(req,5*1024*1024):{};
        const cloudResult=await cloudTimelineApi.handle({
          method:req.method,path,ownerId:user.id,body,query:Object.fromEntries(url.searchParams.entries()),
          idempotencyKey:String(req.headers["idempotency-key"]||"")
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
      if(path==="/api/video-cost-estimate"&&req.method==="POST"){
        if(!rateAllowed("video-cost-estimate:"+user.id,30,60000)){fail(res,429,"RATE_LIMITED","Too many cost estimate requests. Try again shortly.");return;}
        const body=await readJson(req,16*1024);
        const pricing=parseVideoPricingCatalog(process.env.VIDEO_MODEL_PRICING_JSON||"");
        const quote=estimateVideoGenerationCost(body,pricing);
        send(res,200,quote,cors);return;
      }
      if(path==="/api/video-production-quote"&&req.method==="POST"){
        if(!rateAllowed("video-production-quote:"+user.id,20,60000)){fail(res,429,"RATE_LIMITED","Too many production quote requests. Try again shortly.");return;}
        const body=await readJson(req,32*1024);
        const pricing=parseVideoPricingCatalog(process.env.VIDEO_MODEL_PRICING_JSON||"");
        const quote=estimateVideoProductionCost(body,pricing);
        send(res,200,quote,cors);return;
      }
      if(path==="/api/video-production-approvals"&&req.method==="POST"){
        if(!rateAllowed("video-production-approval:"+user.id,10,60000)){fail(res,429,"RATE_LIMITED","Too many production approval requests. Try again shortly.");return;}
        const body=await readJson(req,48*1024);
        const projectId=body.projectId?String(body.projectId):null;
        if(projectId&&!canWriteProject(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
        const idempotencyKey=String(req.headers["idempotency-key"]||body.idempotencyKey||"").trim();
        if(idempotencyKey.length<8||idempotencyKey.length>180){fail(res,400,"IDEMPOTENCY_KEY_REQUIRED","Provide an idempotency key between 8 and 180 characters.");return;}
        const pricing=parseVideoPricingCatalog(process.env.VIDEO_MODEL_PRICING_JSON||"");
        const catalog=getProviderCatalog(process.env);
        const preflight=preflightVideoProduction({shots:body.shots,providerCatalog:catalog,pricingCatalog:pricing});
        let approval;
        try{
          approval=buildVideoGenerationApproval({shots:body.shots,preflight,budget:body.budget,confirmed:body.confirm===true});
        }catch(error){
          const status=error.code==="VIDEO_APPROVAL_CONFIRMATION_REQUIRED"?400:error.code==="VIDEO_APPROVAL_BUDGET_EXCEEDED"?409:error.code==="VIDEO_APPROVAL_PREFLIGHT_REQUIRED"||error.code==="VIDEO_APPROVAL_PRICE_UNVERIFIED"?409:400;
          fail(res,status,error.code||"VIDEO_APPROVAL_INVALID",error.message||"Production approval could not be created.");return;
        }
        const existing=db.prepare("SELECT * FROM video_generation_approvals WHERE owner_id=? AND idempotency_key=?").get(user.id,idempotencyKey);
        if(existing){
          if(existing.request_hash!==approval.requestHash||existing.project_id!==projectId||existing.currency!==approval.currency||existing.quoted_amount_micros!==approval.quotedAmountMicros||existing.budget_ceiling_micros!==approval.budgetCeilingMicros){
            fail(res,409,"IDEMPOTENCY_CONFLICT","This idempotency key was already used for a different approval request.");return;
          }
          send(res,200,{approval:{id:existing.id,status:existing.status,requestHash:existing.request_hash,currency:existing.currency,quotedAmount:existing.quoted_amount_micros/1000000,budgetCeiling:existing.budget_ceiling_micros/1000000,createdAt:existing.created_at},idempotentReplay:true,requestsSubmitted:false},cors);return;
        }
        const id=randomUUID();
        db.prepare("INSERT INTO video_generation_approvals(id,owner_id,project_id,idempotency_key,request_hash,snapshot_json,currency,quoted_amount_micros,budget_ceiling_micros,status) VALUES(?,?,?,?,?,?,?,?,?,'approved_pending_submission')")
          .run(id,user.id,projectId,idempotencyKey,approval.requestHash,approval.snapshotJson,approval.currency,approval.quotedAmountMicros,approval.budgetCeilingMicros);
        audit(db,user.id,"video_generation.approved","video_generation_approval",id,{requestHash:approval.requestHash,shotCount:approval.shotCount,currency:approval.currency,quotedAmountMicros:approval.quotedAmountMicros,budgetCeilingMicros:approval.budgetCeilingMicros,status:approval.status},projectId);
        send(res,201,{approval:{id,status:approval.status,requestHash:approval.requestHash,shotCount:approval.shotCount,currency:approval.currency,quotedAmount:approval.quotedAmountMicros/1000000,budgetCeiling:approval.budgetCeilingMicros/1000000},requestsSubmitted:false,message:"Budget approval recorded. No provider request, credit reservation or generation job was submitted."},cors);return;
      }
      if(path==="/api/video-production-approvals"&&req.method==="GET"){
        const projectId=url.searchParams.get("projectId");
        if(projectId&&!getProjectAccess(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found.");return;}
        const rows=projectId
          ?db.prepare("SELECT id,project_id,request_hash,currency,quoted_amount_micros,budget_ceiling_micros,status,created_at,updated_at FROM video_generation_approvals WHERE owner_id=? AND project_id=? ORDER BY created_at DESC LIMIT 100").all(user.id,projectId)
          :db.prepare("SELECT id,project_id,request_hash,currency,quoted_amount_micros,budget_ceiling_micros,status,created_at,updated_at FROM video_generation_approvals WHERE owner_id=? ORDER BY created_at DESC LIMIT 100").all(user.id);
        send(res,200,{approvals:rows.map(row=>({...row,quoted_amount:row.quoted_amount_micros/1000000,budget_ceiling:row.budget_ceiling_micros/1000000}))},cors);return;
      }
      const videoSubmitMatch=path.match(/^\/api\/video-production-approvals\/([0-9a-f-]{36})\/submit$/i);
      if(videoSubmitMatch&&req.method==="POST"){
        if(!cloudVideoGenerationDispatch){fail(res,503,"CLOUD_VIDEO_DISPATCH_DISABLED","Cloud generation dispatch is disabled. No cloud jobs or provider requests were created.");return;}
        if(!rateAllowed("video-production-submit:"+user.id,10,60000)){fail(res,429,"RATE_LIMITED","Too many generation submissions. Try again shortly.");return;}
        const result=await cloudVideoGenerationDispatch.submit({approvalId:videoSubmitMatch[1],ownerId:user.id});
        send(res,result.status,result.body,cors);return;
      }
      const cloudVideoJobCancelMatch=path.match(/^\/api\/video-generation-jobs\/([0-9a-f-]{36})\/cancel$/i);
      if(cloudVideoJobCancelMatch&&req.method==="POST"){
        if(!rateAllowed("video-job-cancel:"+user.id,20,60000)){fail(res,429,"RATE_LIMITED","Too many video cancellation requests. Try again shortly.");return;}
        if(!cloudVideoGenerationDispatch){fail(res,503,"CLOUD_VIDEO_DISPATCH_DISABLED","Cloud video job cancellation is disabled.");return;}
        const result=await cloudVideoGenerationDispatch.cancelJob({jobId:cloudVideoJobCancelMatch[1],ownerId:user.id});
        send(res,result.status,result.body,cors);return;
      }
      const videoApprovalMatch=path.match(/^\/api\/video-production-approvals\/([0-9a-f-]{36})\/withdraw$/i);
      if(videoApprovalMatch&&req.method==="POST"){
        const changed=db.prepare("UPDATE video_generation_approvals SET status='withdrawn',updated_at=? WHERE id=? AND owner_id=? AND status='approved_pending_submission'").run(now(),videoApprovalMatch[1],user.id);
        if(changed.changes!==1){fail(res,409,"VIDEO_APPROVAL_NOT_WITHDRAWABLE","Approval was not found, is not owned by this user, or is no longer pending.");return;}
        audit(db,user.id,"video_generation.approval_withdrawn","video_generation_approval",videoApprovalMatch[1],{status:"withdrawn"});
        send(res,200,{ok:true,status:"withdrawn",requestsSubmitted:false},cors);return;
      }
      if(path==="/api/video-shot-preflight"&&req.method==="POST"){
        if(!rateAllowed("video-shot-preflight:"+user.id,20,60000)){fail(res,429,"RATE_LIMITED","Too many shot preflight requests. Try again shortly.");return;}
        const body=await readJson(req,32*1024);
        const pricing=parseVideoPricingCatalog(process.env.VIDEO_MODEL_PRICING_JSON||"");
        const catalog=getProviderCatalog(process.env);
        const result=preflightVideoProduction({shots:body.shots,providerCatalog:catalog,pricingCatalog:pricing});
        send(res,200,result,cors);return;
      }
      if(path==="/api/capabilities"&&req.method==="GET"){
        const atlas=getProviderCapabilityAtlas({runwayModel:process.env.RUNWAY_VIDEO_MODEL||""});
        send(res,200,atlas,cors);return;
      }
      if(path==="/api/providers"&&req.method==="GET"){
        const [modelProbes,qualityEvidence]=await Promise.all([Promise.all(["realesrgan-x4plus","realesrgan-x4plus-anime"].map(model=>aiUpscaleAdapter.probe(model))),loadUpscaleQualityEvidence()]);
        const upscaleModels=modelProbes.map(model=>({...model,qualityVerified:qualityEvidence.models[model.model]?.qualityVerified===true,qualityEvidence:qualityEvidence.models[model.model]?.qualityEvidence||null,qualityReason:qualityEvidence.models[model.model]?.reason||qualityEvidence.reason}));
        const aiUpscale={...upscaleModels[0],models:upscaleModels,qualityVerified:upscaleModels[0]?.qualityVerified===true,qualityEvidence:upscaleModels[0]?.qualityEvidence||null};
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
      const assetMatch=path.match(/^\/api\/assets\/([0-9a-f-]+)(?:\/(file|provenance|c2pa))?$/i);
      if(assetMatch){
        const asset=getAccessibleAsset(db,user.id,assetMatch[1],req.method==="DELETE");if(!asset){fail(res,404,"ASSET_NOT_FOUND","Asset not found.");return;}
        if(assetMatch[2]==="provenance"&&req.method==="GET"){
          const metadata=parseJson(asset.metadata_json,{}),provenance=metadata.provenance||null;
          const verification=verifyAssetProvenanceRecord(provenance,{id:asset.id,sha256:asset.sha256,mediaType:asset.media_type,size:Number(asset.byte_size)});
          send(res,200,{assetId:asset.id,provenance,verification,notice:"Internal integrity verification is not a C2PA signature, identity proof, rights clearance or factual verification."},cors);return;
        }
        if(assetMatch[2]==="c2pa"&&req.method==="GET"){
           const file=resolve(MEDIA_ROOT,asset.storage_path),mediaPrefix=MEDIA_ROOT.endsWith(sep)?MEDIA_ROOT:MEDIA_ROOT+sep;
           if(!file.startsWith(mediaPrefix)){fail(res,404,"ASSET_NOT_FOUND","Asset not found.");return;}
           const verification=await verifyC2paAsset({filePath:file,mediaType:asset.media_type,expectedSha256:asset.sha256,expectedSize:Number(asset.byte_size)});
           send(res,200,{assetId:asset.id,verification,notice:"C2PA validity and signer trust are separate from application provenance, identity, rights clearance and factual accuracy."},cors);return;
         }
         if(assetMatch[2]==="file"&&req.method==="GET"){
          const file=resolve(MEDIA_ROOT,asset.storage_path),mediaPrefix=MEDIA_ROOT.endsWith(sep)?MEDIA_ROOT:MEDIA_ROOT+sep;
          if(!file.startsWith(mediaPrefix)||!existsSync(file)||!statSync(file).isFile()){fail(res,404,"ASSET_NOT_FOUND","Asset not found.");return;}
          res.once("finish",()=>{
            if(res.statusCode!==200)return;
            audit(db,user.id,"asset.downloaded","asset",asset.id,{mediaType:asset.media_type,size:Number(asset.byte_size),sha256:asset.sha256},asset.project_id);
            controlRemediationApi.recordEvidenceDownload({ownerId:user.id,assetId:asset.id});
          });
          res.writeHead(200,{"content-type":asset.media_type,"content-length":asset.byte_size,"content-disposition":`inline; filename="${safeName(asset.original_name)}"`,"cache-control":"private, no-store",...SECURITY_HEADERS,...cors});
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
        const saved={...timeline,id,projectId,name,revision:1};
        db.prepare("INSERT INTO timelines(id,owner_id,project_id,name,timeline_json,otio_json) VALUES(?,?,?,?,?,?)")
          .run(id,user.id,projectId,name,json(saved),body.otio?json(body.otio):null);
        audit(db,user.id,"timeline.created","timeline",id,{revision:1},projectId);
        send(res,201,{timeline:{id,projectId,name,revision:1,document:saved}},cors);return;
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
          const saved={...timeline,id:record.id,projectId,name,revision};
          const changed=db.prepare("UPDATE timelines SET project_id=?,name=?,revision=?,timeline_json=?,otio_json=?,updated_at=? WHERE id=? AND revision=?")
            .run(projectId,name,revision,json(saved),body.otio?json(body.otio):record.otio_json,now(),record.id,record.revision);
          if(changed.changes!==1){fail(res,409,"REVISION_CONFLICT","Timeline changed while saving. Refresh and retry.");return;}
          audit(db,user.id,"timeline.updated","timeline",record.id,{revision},projectId);
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
          const waitingOutput=parseJson(waiting.output_json,{});
          if(node?.kind==="video.generate"){
            if(access?.access_role!=="owner"||!run.project_id||!cloudTimelineApi){fail(res,403,"VIDEO_WORKFLOW_PROJECT_OWNER_REQUIRED","Only the project owner with an authenticated cloud workspace can approve this paid generation quote.");return;}
            const quote=waitingOutput.videoQuote;
            if(!quote||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(quote.quoteId||""))||!/^[A-Za-z0-9._:-]{1,160}$/.test(String(quote.requestId||""))||!/^[a-f0-9]{64}$/.test(String(quote.requestHash||""))||
               !Number.isFinite(Number(quote.estimatedAmount))||Number(quote.estimatedAmount)<=0||!quote.cloudNode||!quote.cloudValues){
              fail(res,409,"VIDEO_WORKFLOW_QUOTE_NOT_PENDING","This workflow has no valid pending cloud video quote. Refresh the workflow and request a new quote.");return;
            }
            const approvalBody=await readJson(req,32*1024);
            if(approvalBody.confirmed!==true){fail(res,403,"VIDEO_WORKFLOW_APPROVAL_CONFIRMATION_REQUIRED","Explicit confirmation of the exact cloud quote is required.");return;}
            const approvedMaxAmount=Number(approvalBody.approvedMaxAmount);
            if(!Number.isFinite(approvedMaxAmount)||approvedMaxAmount<Number(quote.estimatedAmount)||approvedMaxAmount>1000000||
               Math.abs(approvedMaxAmount*1000000-Math.round(approvedMaxAmount*1000000))>0.0001){
              fail(res,400,"VIDEO_WORKFLOW_APPROVED_AMOUNT_INVALID","Approved USD ceiling must be at least the quote and have at most six decimal places.");return;
            }
            const approval=await cloudTimelineApi.handle({method:"POST",path:"/api/cloud/workflows/video/approve",ownerId:user.id,body:{
              confirmed:true,projectId:run.project_id,quoteId:quote.quoteId,requestId:quote.requestId,
              node:quote.cloudNode,values:quote.cloudValues,approvedMaxAmount,
              approvalNote:String(approvalBody.approvalNote||"Approved by project owner in Video Studio").slice(0,1000)
            }});
            if(!approval||![200,202].includes(approval.status)){send(res,approval?.status||503,{error:approval?.body?.error||{code:"VIDEO_WORKFLOW_APPROVAL_FAILED",message:"The cloud quote could not be approved. No workflow job was queued."}},cors);return;}
            const cloudJobId=String(approval.body?.job?.id||"");
            if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cloudJobId)){fail(res,502,"VIDEO_WORKFLOW_JOB_RECEIPT_INVALID","Cloud approval did not return a valid durable job receipt.");return;}
            const receipt={cloudJobId,quoteId:quote.quoteId,requestId:quote.requestId,requestHash:quote.requestHash,
              routedModel:quote.routedModel,approvedMaxAmount,status:approval.body?.job?.status||"queued",approvedBy:user.id,approvedAt:now()};
            const enqueueApprovedRun=db.transaction(()=>{
              const claimed=db.prepare("UPDATE workflow_node_runs SET status='blocked',output_json=?,error_json=NULL,completed_at=NULL WHERE id=? AND status='awaiting_approval'").run(json(receipt),waiting.id);
              if(claimed.changes!==1)return null;
              const localJobId=randomUUID();
              db.prepare("UPDATE workflow_runs SET status='queued',job_id=?,updated_at=?,error_json=NULL,completed_at=NULL WHERE id=?").run(localJobId,now(),run.id);
              db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json) VALUES(?,?,?,'workflow.execute','queued',0,?)").run(localJobId,run.owner_id,run.project_id,json({runId:run.id}));
              addJobEvent(db,localJobId,run.owner_id,"job.queued",{jobType:"workflow.execute",runId:run.id,approvedVideoQuoteId:quote.quoteId,cloudJobId});
              audit(db,user.id,"workflow.video_generation_approved","workflow_run",run.id,{nodeId:waiting.node_id,quoteId:quote.quoteId,cloudJobId,approvedMaxAmount},run.project_id);
              return localJobId;
            });
            const jobId=enqueueApprovedRun();
            if(!jobId){
              const current=db.prepare("SELECT status,output_json FROM workflow_node_runs WHERE id=?").get(waiting.id);
              const currentReceipt=parseJson(current?.output_json,{});
              if(currentReceipt.cloudJobId===cloudJobId){send(res,200,{runId:run.id,status:"queued",cloudJobId,idempotentReplay:true},cors);return;}
              fail(res,409,"VIDEO_WORKFLOW_APPROVAL_RACE","The workflow approval changed while the cloud job was being queued. Refresh the run before retrying.");return;
            }
            send(res,202,{runId:run.id,jobId,status:"queued",cloudJobId},cors);return;
          }
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
      if(path==="/api/jobs/batch"&&req.method==="POST"){
        const body=await readJson(req);
        const items=body.items;
        if(!Array.isArray(items)||items.length<1||items.length>100){
          fail(res,400,"INVALID_BATCH","Batch must contain between 1 and 100 image assets.");return;
        }
        let projectId=body.projectId||null;
        if(projectId&&!canWriteProject(db,user.id,projectId)){
          fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;
        }
        const normalized=[];
        const seenAssets=new Set();
        for(const [index,item] of items.entries()){
          if(!item||typeof item!=="object"||Array.isArray(item)){
            fail(res,400,"INVALID_BATCH_ITEM","Every batch item must be an object.");return;
          }
          const sourceAssetId=String(item.sourceAssetId||"");
          if(!sourceAssetId||seenAssets.has(sourceAssetId)){
            fail(res,400,"INVALID_BATCH_ITEM","Each batch item needs a unique sourceAssetId.");return;
          }
          seenAssets.add(sourceAssetId);
          const source=getAccessibleAsset(db,user.id,sourceAssetId,true);
          if(!source||!String(source.media_type||"").startsWith("image/")){
            fail(res,404,"SOURCE_ASSET_NOT_FOUND","Every source must be an accessible image.");return;
          }
          const sourceProjectId=source.project_id||null;
          if(index===0&&!body.projectId)projectId=sourceProjectId;
          if(sourceProjectId!==projectId){
            fail(res,400,"PROJECT_MISMATCH","All batch images must belong to the same selected project or private workspace.");return;
          }
          const model=String(item.model||body.model||"realesrgan-x4plus");
          try{
            aiUpscaleAdapter.plan({
              inputPath:"/tmp/executive-visuals-batch-input",
              outputPath:"/tmp/executive-visuals-batch-output",
              model,scale:item.scale??body.scale??4,tile:item.tile??body.tile??0,
              format:item.format||body.format||"png"
            });
          }catch(error){
            fail(res,400,error.code||"INVALID_MEDIA_OPTIONS",error.message);return;
          }
          normalized.push({
            sourceAssetId,model,scale:item.scale??body.scale??4,tile:item.tile??body.tile??0,
            format:item.format||body.format||"png",index
          });
        }
        const evidence=await loadUpscaleQualityEvidence();
        const models=[...new Set(normalized.map(item=>item.model))];
        for(const model of models){
          if(evidence.models[model]?.qualityVerified!==true){
            fail(res,409,"AI_UPSCALE_QUALITY_NOT_VERIFIED","Every selected model must pass its model-specific five-category human-reviewed benchmark before batch submission.");return;
          }
          const readiness=await aiUpscaleAdapter.probe(model);
          if(!readiness.available||!readiness.executionEnabled||!readiness.executionVerified){
            fail(res,409,"AI_UPSCALE_MODEL_NOT_READY","Every selected model must have installed weights, explicit worker enablement and a successful model-specific execution self-test.");return;
          }
        }
        const batchId=randomUUID();
        const jobs=[];
        db.exec("BEGIN IMMEDIATE");
        try{
          for(const item of normalized){
            const id=randomUUID();
            const input={sourceAssetId:item.sourceAssetId,model:item.model,scale:item.scale,tile:item.tile,format:item.format,batchId,batchIndex:item.index,batchTotal:normalized.length};
            db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json) VALUES(?,?,?,'media.ai-upscale','queued',?)")
              .run(id,user.id,projectId,json(input));
            addJobEvent(db,id,user.id,"job.queued",{jobType:"media.ai-upscale",batchId,batchIndex:item.index,batchTotal:normalized.length});
            jobs.push(recordJob(db.prepare("SELECT * FROM jobs WHERE id=?").get(id)));
          }
          audit(db,user.id,"upscale.batch_queued","batch",batchId,{total:jobs.length,models},projectId);
          db.exec("COMMIT");
        }catch(error){
          try{db.exec("ROLLBACK");}catch{}
          throw error;
        }
        send(res,202,{batchId,status:"queued",total:jobs.length,jobs},cors);return;
      }
      if(path==="/api/jobs"&&req.method==="GET"){
        const rows=db.prepare("SELECT * FROM jobs WHERE (project_id IS NULL AND owner_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?) OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY created_at DESC LIMIT 100").all(user.id,user.id,user.id);
        send(res,200,{jobs:rows.map(recordJob)},cors);return;
      }
      if(path==="/api/jobs"&&req.method==="POST"){
        const body=await readJson(req);const type=String(body.jobType||"");
        if(!MEDIA_JOBS.has(type)){fail(res,409,"ENGINE_UNAVAILABLE","This capability has no connected execution adapter yet. No paid request was sent.");return;}
        if(type==="media.ai-upscale"){
          const model=String(body.model||"realesrgan-x4plus");
          const evidence=await loadUpscaleQualityEvidence();
          if(evidence.models[model]?.qualityVerified!==true){fail(res,409,"AI_UPSCALE_QUALITY_NOT_VERIFIED","The selected model is not enabled. Complete its model-specific five-category human-reviewed benchmark before submitting an upscale job.");return;}
          const readiness=await aiUpscaleAdapter.probe(model);
          if(!readiness.available||!readiness.executionEnabled||!readiness.executionVerified){fail(res,409,"AI_UPSCALE_MODEL_NOT_READY","The selected model must have installed weights, explicit worker enablement and a successful model-specific execution self-test.");return;}
        }
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
if (AUTH_MODE==="supabase"&&(!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY)) {
  throw new Error("Supabase authentication requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
}
// Keep static health and planning surfaces available when the operator has not provisioned the session-encryption secret. Supabase-authenticated routes fail closed with a clear 503 until configured.
if (process.env.NODE_ENV!=="test") {
  const server=createAppServer();
  server.listen(PORT,HOST,()=>process.stdout.write(`Executive Visuals API listening on http://${HOST}:${PORT}\n`));
  const shutdown=()=>{if(workerTimer)clearInterval(workerTimer);for(const child of activeProcesses.values())if(!child.killed)child.kill("SIGTERM");server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
  process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
}
