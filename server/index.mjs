import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, unlink, open } from "node:fs/promises";
import { dirname, extname, join, resolve, basename, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { openDatabase, audit, addJobEvent, getOwnedProject, getOwnedAsset, getProjectAccess, canWriteProject, getAccessibleAsset, json, parseJson } from "./db.mjs";
import { executeMediaJob, executableAvailable } from "./media.mjs";
import { validateWorkflowGraph } from "./workflow-validation.mjs";
import { validateTimelineDocument } from "./timeline-validation.mjs";

const PORT = Number(process.env.API_PORT || process.env.PORT || 4179);
const HOST = process.env.API_HOST || "127.0.0.1";
const AUTH_MODE = process.env.AUTH_MODE || "local";
const DATA_DIR = resolve(process.env.DATA_DIR || "./data");
const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT || join(DATA_DIR, "media"));
const WEB_ROOT = resolve(process.env.WEB_ROOT || "./dist");
const DB_FILE = resolve(process.env.DB_FILE || join(DATA_DIR, "executive-visuals.sqlite"));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 250 * 1024 * 1024);
const SESSION_DAYS = 30;
const ALLOWED_MEDIA = new Set([
  "image/jpeg","image/png","image/webp","image/gif",
  "video/mp4","video/webm","video/quicktime","video/x-matroska",
  "audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/ogg",
  "application/pdf","text/plain","application/json"
]);
const EXTENSIONS = {
  "image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif",
  "video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","video/x-matroska":"mkv",
  "audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/ogg":"ogg",
  "application/pdf":"pdf","text/plain":"txt","application/json":"json"
};
const MEDIA_JOBS = new Set(["media.probe","media.thumbnail","media.transcode","media.audio_extract","media.proxy"]);
const db = openDatabase(DB_FILE);
const activeProcesses = new Map();
const rateBuckets = new Map();
function rateAllowed(key,limit,windowMs){const time=Date.now();const old=rateBuckets.get(key);if(!old||time-old.start>=windowMs){rateBuckets.set(key,{start:time,count:1});return true;}old.count++;return old.count<=limit;}
await mkdir(join(MEDIA_ROOT,"uploads"), { recursive:true });
await mkdir(join(MEDIA_ROOT,"derived"), { recursive:true });

const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const safeName = value => basename(String(value || "upload")).replace(/[\u0000-\u001f\u007f]/g,"").replace(/[^\p{L}\p{N}._() -]/gu,"_").slice(0,180) || "upload";
const send = (res,status,body,headers={}) => { res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",...headers});res.end(JSON.stringify(body)); };
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
function createLocalSession(userId) {
  const token=randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .run(hash(token),userId,new Date(Date.now()+SESSION_DAYS*86400000).toISOString());
  return token;
}
async function authenticate(req) {
  if (AUTH_MODE === "supabase") {
    const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
    if(!token||!process.env.SUPABASE_URL||!process.env.SUPABASE_PUBLISHABLE_KEY)return null;
    const response=await fetch(process.env.SUPABASE_URL.replace(/\/$/,"")+"/auth/v1/user",{
      headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,authorization:"Bearer "+token}
    });
    if(!response.ok)return null;
    const user=await response.json();
    if(!user?.id)return null;
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
    error:parseJson(dbRow.error_json,null),attempts:dbRow.attempt_count,
    createdAt:dbRow.created_at,updatedAt:dbRow.updated_at,startedAt:dbRow.started_at,completedAt:dbRow.completed_at
  };
}
function accessibleJob(ownerId,id,write=false) {
  const job=db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  if(!job)return null;
  if(job.owner_id===ownerId)return job;
  if(!job.project_id)return null;
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
  if(type==="text/plain")return !header.includes(0);
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
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path) VALUES(?,?,?,?,?,?,?,?)")
    .run(id,user.id,projectId||null,originalName,mediaType,size,sha256,relative);
  audit(db,user.id,"asset.uploaded","asset",id,{name:originalName,mediaType,size,sha256},projectId||null);
  return {id,projectId:projectId||null,name:originalName,mediaType,size,sha256,createdAt:now()};
}
async function processNextJob() {
  const job=db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
  if(!job)return;
  const updated=db.prepare("UPDATE jobs SET status='running',progress=5,attempt_count=attempt_count+1,started_at=?,updated_at=? WHERE id=? AND status='queued'")
    .run(now(),now(),job.id);
  if(updated.changes!==1)return;
  const current=db.prepare("SELECT * FROM jobs WHERE id=?").get(job.id);
  addJobEvent(db,job.id,job.owner_id,"job.started",{attempt:current.attempt_count});
  try {
    const result=await executeMediaJob({
      db,job:current,mediaRoot:MEDIA_ROOT,activeProcesses,
      onProgress:value=>{
        db.prepare("UPDATE jobs SET progress=?,updated_at=? WHERE id=? AND status='running'").run(value,now(),job.id);
        addJobEvent(db,job.id,job.owner_id,"job.progress",{progress:value});
      }
    });
    const latest=db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id);
    if(latest?.status==="cancelled")return;
    db.prepare("UPDATE jobs SET status='succeeded',progress=100,output_json=?,updated_at=?,completed_at=? WHERE id=?")
      .run(json(result),now(),now(),job.id);
    addJobEvent(db,job.id,job.owner_id,"job.succeeded",{output:result});
    audit(db,job.owner_id,"job.succeeded","job",job.id,{jobType:job.job_type},job.project_id);
  } catch(error) {
    const latest=db.prepare("SELECT status,attempt_count,max_attempts FROM jobs WHERE id=?").get(job.id);
    if(latest?.status==="cancelled")return;
    const retryable=["MEDIA_TIMEOUT","MEDIA_PROCESS_FAILED"].includes(error.code);
    const retry=retryable&&latest.attempt_count<latest.max_attempts;
    const status=retry?"queued":"failed";
    const details={code:error.code||"MEDIA_JOB_FAILED",message:String(error.message||"Media job failed.").slice(0,1000),retryable};
    db.prepare("UPDATE jobs SET status=?,error_json=?,updated_at=?,completed_at=? WHERE id=?")
      .run(status,json(details),now(),retry?null:now(),job.id);
    addJobEvent(db,job.id,job.owner_id,retry?"job.retry_scheduled":"job.failed",details);
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
    const ratePath=path.startsWith("/api/auth/")?"/auth":path==="/api/assets"&&req.method==="POST"?"/upload":"";
    if(ratePath){const key=(req.socket.remoteAddress||"unknown")+ratePath;const limit=ratePath==="/auth"?12:30;if(!rateAllowed(key,limit,60000)){fail(res,429,"RATE_LIMITED","Too many requests. Wait before trying again.");return;}}
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
          res.writeHead(200,{"content-type":types[ext]||"application/octet-stream","x-content-type-options":"nosniff","cache-control":ext===".html"?"no-cache":"public, max-age=31536000, immutable",...cors});
          createReadStream(file).pipe(res);return;
        }
      }
      if(path==="/api/health"&&req.method==="GET"){
        send(res,200,{status:"ok",storage:"local-disk",database:"sqlite",media:{ffmpeg:executableAvailable("ffmpeg"),ffprobe:executableAvailable("ffprobe")},authMode:AUTH_MODE,version:"0.1.0"},cors);return;
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
      if(path==="/api/auth/login"&&req.method==="POST"){
        if(AUTH_MODE!=="local"){fail(res,403,"USE_EXTERNAL_AUTH","Sign in through the configured identity provider.");return;}
        const body=await readJson(req);const email=String(body.email||"").trim().toLowerCase();const password=String(body.password||"");
        const user=db.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(email);
        const candidate=user?scryptSync(password,user.password_salt,64).toString("hex"):"";
        const valid=!!user&&candidate.length===user.password_hash.length&&timingSafeEqual(Buffer.from(candidate,"hex"),Buffer.from(user.password_hash,"hex"));
        if(!valid){fail(res,401,"INVALID_CREDENTIALS","Email or password is incorrect.");return;}
        const token=createLocalSession(user.id);setCookie(res,token,SESSION_DAYS*86400);
        send(res,200,{user:{id:user.id,email:user.email},authMode:"local"},cors);return;
      }
      if(path==="/api/auth/logout"&&req.method==="POST"){
        const token=cookieValue(req,"ev_session");if(token)db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
        setCookie(res,"",0);send(res,200,{ok:true},cors);return;
      }
      const user=await authenticate(req);
      if(!user){fail(res,401,"AUTH_REQUIRED","Sign in to access this workspace.");return;}
      if(path==="/api/me"&&req.method==="GET"){send(res,200,{user,authMode:AUTH_MODE},cors);return;}

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

      if(path==="/api/assets"&&req.method==="GET"){
        const projectId=url.searchParams.get("projectId");
        const rows=projectId&&!getProjectAccess(db,user.id,projectId)?[]:db.prepare("SELECT id,project_id,original_name,media_type,byte_size,sha256,derivative_of,metadata_json,created_at FROM assets WHERE deleted_at IS NULL AND (owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?)) AND (? IS NULL OR project_id=?) ORDER BY created_at DESC").all(user.id,user.id,projectId,projectId);
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
          res.writeHead(200,{"content-type":asset.media_type,"content-length":asset.byte_size,"content-disposition":`inline; filename="${safeName(asset.original_name)}"`,"x-content-type-options":"nosniff",...cors});
          createReadStream(file).pipe(res);return;
        }
        if(req.method==="DELETE"){
          db.prepare("UPDATE assets SET deleted_at=? WHERE id=? AND owner_id=?").run(now(),asset.id,user.id);
          audit(db,user.id,"asset.archived","asset",asset.id,{});send(res,200,{ok:true},cors);return;
        }
      }

      if(path==="/api/workflows"&&req.method==="GET"){
        const rows=db.prepare("SELECT id,project_id,name,revision,graph_json,graph_hash,created_at,updated_at FROM workflows WHERE owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY updated_at DESC").all(user.id,user.id);
        send(res,200,{workflows:rows.map(x=>({id:x.id,projectId:x.project_id,name:x.name,revision:x.revision,graph:parseJson(x.graph_json),graphHash:x.graph_hash,createdAt:x.created_at,updatedAt:x.updated_at}))},cors);return;
      }
      if(path==="/api/workflows"&&req.method==="POST"){
        const body=await readJson(req);const name=String(body.name||"Untitled workflow").trim().slice(0,160);const graph=body.graph;
        if(!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)){fail(res,400,"INVALID_WORKFLOW","A workflow graph with nodes and edges is required.");return;}
        const validation=validateWorkflowGraph(graph);
        if(!validation.valid){send(res,422,{error:{code:"WORKFLOW_INVALID",message:"Workflow graph failed validation.",issues:validation.issues}},cors);return;}
        if(body.projectId&&!canWriteProject(db,user.id,body.projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
        const id=randomUUID(),graphJson=json(graph),graphHash=hash(graphJson);
        db.prepare("INSERT INTO workflows(id,owner_id,project_id,name,graph_json,graph_hash) VALUES(?,?,?,?,?,?)").run(id,user.id,body.projectId||null,name,graphJson,graphHash);
        audit(db,user.id,"workflow.created","workflow",id,{graphHash},body.projectId||null);send(res,201,{workflow:{id,name,revision:1,graphHash}},cors);return;
      }

      if(path==="/api/timelines"&&req.method==="GET"){
        const rows=db.prepare("SELECT id,project_id,name,revision,created_at,updated_at FROM timelines WHERE archived_at IS NULL AND (owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?)) ORDER BY updated_at DESC").all(user.id,user.id);
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
        const record=db.prepare("SELECT * FROM timelines WHERE id=? AND archived_at IS NULL AND (owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))").get(timelineMatch[1],user.id,user.id);
        if(!record){fail(res,404,"TIMELINE_NOT_FOUND","Timeline not found.");return;}
        if(timelineMatch[2]==="otio"&&req.method==="GET"){
          if(!record.otio_json){fail(res,404,"INTERCHANGE_NOT_AVAILABLE","No interchange export has been saved.");return;}
          send(res,200,{otio:parseJson(record.otio_json)},cors);return;
        }
        if(!timelineMatch[2]&&req.method==="GET"){
          send(res,200,{timeline:{id:record.id,projectId:record.project_id,name:record.name,revision:record.revision,document:parseJson(record.timeline_json),createdAt:record.created_at,updatedAt:record.updated_at}},cors);return;
        }
        if(!timelineMatch[2]&&req.method==="PUT"){
          if(record.owner_id!==user.id&&(!record.project_id||!canWriteProject(db,user.id,record.project_id))){fail(res,403,"EDITOR_REQUIRED","Editor access is required to edit this timeline.");return;}
          const body=await readJson(req,4*1024*1024);
          if(Number(body.revision)!==record.revision){fail(res,409,"REVISION_CONFLICT","Timeline changed since it was loaded. Refresh and retry.");return;}
          const timeline=body.timeline,validation=validateTimelineDocument(timeline,db,user.id);
          if(!validation.valid){send(res,422,{error:{code:"TIMELINE_INVALID",message:"Timeline failed validation.",issues:validation.issues}},cors);return;}
          const projectId=body.projectId??record.project_id;
          if(projectId&&!canWriteProject(db,user.id,projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
          const revision=record.revision+1,name=String(body.name||timeline.name||record.name).trim().slice(0,160);
          const saved={...timeline,id:record.id,projectId,name,revision};
          db.prepare("UPDATE timelines SET project_id=?,name=?,revision=?,timeline_json=?,otio_json=?,updated_at=? WHERE id=? AND owner_id=?")
            .run(projectId,name,revision,json(saved),body.otio?json(body.otio):record.otio_json,now(),record.id,user.id);
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
      const workflowMatch=path.match(/^\/api\/workflows\/([0-9a-f-]+)$/i);
      if(workflowMatch){
        const workflow=db.prepare("SELECT * FROM workflows WHERE id=? AND (owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?))").get(workflowMatch[1],user.id,user.id);
        if(!workflow){fail(res,404,"WORKFLOW_NOT_FOUND","Workflow not found.");return;}
        if(req.method==="GET"){
          send(res,200,{workflow:{id:workflow.id,projectId:workflow.project_id,name:workflow.name,revision:workflow.revision,graph:parseJson(workflow.graph_json),graphHash:workflow.graph_hash,createdAt:workflow.created_at,updatedAt:workflow.updated_at}},cors);return;
        }
        if(req.method==="PUT"){
          if(workflow.owner_id!==user.id&&(!workflow.project_id||!canWriteProject(db,user.id,workflow.project_id))){fail(res,403,"EDITOR_REQUIRED","Editor access is required to change this workflow.");return;}
          const body=await readJson(req);
          if(Number(body.revision)!==workflow.revision){fail(res,409,"REVISION_CONFLICT","Workflow changed since it was loaded. Refresh and retry.");return;}
          if(!body.graph||!Array.isArray(body.graph.nodes)||!Array.isArray(body.graph.edges)){fail(res,400,"INVALID_WORKFLOW","A workflow graph with nodes and edges is required.");return;}
          const validation=validateWorkflowGraph(body.graph);
          if(!validation.valid){send(res,422,{error:{code:"WORKFLOW_INVALID",message:"Workflow graph failed validation.",issues:validation.issues}},cors);return;}
          const graphJson=json(body.graph),graphHash=hash(graphJson),name=String(body.name||workflow.name).trim().slice(0,160);
          db.prepare("UPDATE workflows SET name=?,graph_json=?,graph_hash=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?")
            .run(name,graphJson,graphHash,now(),workflow.id,user.id);
          audit(db,user.id,"workflow.updated","workflow",workflow.id,{revision:workflow.revision+1,graphHash},workflow.project_id);
          send(res,200,{ok:true,revision:workflow.revision+1,graphHash},cors);return;
        }
      }
      if(path==="/api/jobs"&&req.method==="GET"){
        const rows=db.prepare("SELECT * FROM jobs WHERE owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY created_at DESC LIMIT 100").all(user.id,user.id);
        send(res,200,{jobs:rows.map(recordJob)},cors);return;
      }
      if(path==="/api/jobs"&&req.method==="POST"){
        const body=await readJson(req);const type=String(body.jobType||"");
        if(!MEDIA_JOBS.has(type)){fail(res,409,"ENGINE_UNAVAILABLE","This capability has no connected execution adapter yet. No paid request was sent.");return;}
        if(body.projectId&&!canWriteProject(db,user.id,body.projectId)){fail(res,404,"PROJECT_NOT_FOUND","Project not found or editor access required.");return;}
        if(!body.sourceAssetId||!getAccessibleAsset(db,user.id,String(body.sourceAssetId),true)){fail(res,404,"SOURCE_ASSET_NOT_FOUND","Choose a source asset you own or can edit.");return;}
        const key=String(req.headers["idempotency-key"]||body.idempotencyKey||"").slice(0,180);
        if(key){const existing=db.prepare("SELECT * FROM jobs WHERE owner_id=? AND idempotency_key=?").get(user.id,key);if(existing){send(res,200,{job:recordJob(existing),idempotentReplay:true},cors);return;}}
        const id=randomUUID(),input={...body};delete input.idempotencyKey;
        db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json,idempotency_key) VALUES(?,?,?,?,'queued',?,?)")
          .run(id,user.id,body.projectId||null,type,json(input),key||null);
        addJobEvent(db,id,user.id,"job.queued",{jobType:type});audit(db,user.id,"job.queued","job",id,{jobType:type},body.projectId||null);
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

      if(path==="/api/audit"&&req.method==="GET"){
        const rows=db.prepare("SELECT id,project_id,event_type,subject_type,subject_id,details_json,created_at FROM audit_events WHERE owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) ORDER BY id DESC LIMIT 200").all(user.id,user.id);
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
if (process.env.NODE_ENV!=="test") {
  const server=createAppServer();
  server.listen(PORT,HOST,()=>process.stdout.write(`Executive Visuals API listening on http://${HOST}:${PORT}\n`));
  const shutdown=()=>{if(workerTimer)clearInterval(workerTimer);for(const child of activeProcesses.values())if(!child.killed)child.kill("SIGTERM");server.close(()=>{db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();};
  process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
}
