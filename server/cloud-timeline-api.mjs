import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, extname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudTimelineService } from "./cloud-timeline-service.mjs";
import { buildTransformationReadinessReport } from "./transformation-readiness.mjs";
import { validateSrt, validateWebVtt } from "./caption-validation.mjs";
import { REQUIRED_UPSCALE_FIXTURE_CATEGORIES, buildUpscaleBenchmarkRecordFromAsset, compareUpscaleBenchmarkCandidates } from "./upscale-benchmark.mjs";
import { createDeliveryPackage, verifyDeliveryManifest } from "./delivery-manifest.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId=(value)=>typeof value==="string"&&UUID.test(value);
const stableJson=value=>Array.isArray(value)?"["+value.map(stableJson).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stableJson(value[key])).join(",")+"}":JSON.stringify(value);

/**
 * Authenticated cloud timeline API. The caller must pass the user ID returned
 * by the app's verified authentication middleware; request bodies never set
 * owner_id. Service-role credentials remain inside this server-only module.
 */
export function createCloudTimelineApi({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,timelineService,authorize,maxJobBytes=5*1024*1024,timeoutMs=15000,maxUploadBytes=250*1024*1024,tempRoot=tmpdir(),transformationReadiness=()=>({})}={}){
 if(!url||!serviceRoleKey)throw new Error("Cloud timeline API requires server-side Supabase credentials.");
 if(typeof fetchImpl!=="function")throw new Error("Cloud timeline API requires fetch.");
 if(!Number.isInteger(maxJobBytes)||maxJobBytes<1024||maxJobBytes>10*1024*1024)throw new Error("Cloud timeline API payload limit is invalid.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw new Error("Cloud timeline API timeout is invalid.");
 if(!Number.isInteger(maxUploadBytes)||maxUploadBytes<1||maxUploadBytes>1024*1024*1024)throw new Error("Cloud asset upload limit is invalid.");
 const service=timelineService||createCloudTimelineService({url,serviceRoleKey,fetchImpl});
 const allow=authorize||createCloudAssetAuthorizer({url,serviceRoleKey,fetchImpl});
 const base=new URL(url).origin;
 async function request(path,{method="GET",body=null,prefer="return=representation"}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
  const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",prefer};
  if(body!==null)headers["content-type"]="application/json";
  const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
  const raw=await response.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Cloud timeline API received an invalid database response.");}}
  if(!response.ok){const error=new Error("Cloud timeline API database request failed (HTTP "+response.status+").");error.status=response.status;error.databaseCode=data?.code||null;error.code="CLOUD_TIMELINE_API_DATABASE_ERROR";throw error;}
  return data;
  }catch(error){if(error?.name==="AbortError"){const timeout=new Error("Cloud timeline API request timed out.");timeout.code="CLOUD_TIMELINE_API_TIMEOUT";throw timeout;}throw error;}finally{clearTimeout(timer);}
 }
 const response=(status,body)=>({status,body});
 async function handle({method,path,ownerId,body={},query={},idempotencyKey=null}={}){
  if(!["GET","POST","PUT","PATCH","DELETE"].includes(method)||typeof path!=="string")return null;
  if(!safeId(ownerId))return response(401,{error:{code:"AUTH_REQUIRED",message:"A verified account identity is required."}});
  if(Buffer.byteLength(JSON.stringify(body||{}))>maxJobBytes)return response(413,{error:{code:"PAYLOAD_TOO_LARGE",message:"Cloud timeline request is too large."}});
  try{
   if(path==="/api/cloud/projects"&&method==="POST"){
    const project=await service.projects.create({ownerId,name:body.name,description:body.description||"",settings:body.settings||{}});
    return response(201,{project});
   }
   if(path==="/api/cloud/projects"&&method==="GET"){
    const projects=await service.projects.list({ownerId,limit:Number(query.limit)||50,offset:Number(query.offset)||0});
    return response(200,{projects});
   }
   const projectMatch=path.match(/^\/api\/cloud\/projects\/([0-9a-f-]+)$/i);
   if(projectMatch&&safeId(projectMatch[1])){
    const projectId=projectMatch[1];
    if(method==="GET"){const project=await service.projects.get({ownerId,projectId});return project?response(200,{project}):response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});}
    if(method==="PATCH"){const project=await service.projects.update({ownerId,projectId,expectedRevision:Number(body.expectedRevision),name:body.name,description:body.description,settings:body.settings});return response(200,{project});}
    if(method==="DELETE"){const archived=await service.projects.archive({ownerId,projectId,expectedRevision:Number(body.expectedRevision)});return response(200,{project:archived});}
   }
   if(path==="/api/cloud/upscale-jobs"&&method==="GET"){
    const projectId=String(query.projectId||"");
    if(!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Choose a valid project."}});
    if(await allow({ownerId,projectId,action:"read"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or access denied."}});
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at&project_id=eq."+encodeURIComponent(projectId)+"&job_type=eq.media.ai-upscale&order=created_at.desc&limit=50");
    return response(200,{jobs:(rows||[]).map(row=>({id:row.id,status:row.status,progress:Number(row.progress||0),input:row.input||{},output:row.output||null,error:row.error||null,createdAt:row.created_at,updatedAt:row.updated_at}))});
   }
   if(path==="/api/cloud/upscale"&&method==="POST"){
    const projectId=String(body.projectId||""),sourceAssetId=String(body.sourceAssetId||"");
    if(!safeId(projectId)||!safeId(sourceAssetId))return response(400,{error:{code:"UPSCALE_INPUT_INVALID",message:"Choose a valid project and source image."}});
    if(await allow({ownerId,projectId,action:"write"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or editor access required."}});
    const source=await service.assets.get({ownerId,assetId:sourceAssetId});
    if(source.projectId!==projectId||!["image/png","image/jpeg","image/webp"].includes(source.mediaType))return response(422,{error:{code:"UPSCALE_SOURCE_INVALID",message:"AI upscaling accepts project PNG, JPEG or WebP still images only."}});
    if(body.rightsConfirmed!==true)return response(403,{error:{code:"MEDIA_RIGHTS_REQUIRED",message:"Confirm that you have the rights to process this source image."}});
    const model=String(body.model||"realesrgan-x4plus"),scale=Number(body.scale??4),tile=Number(body.tile??0),format=String(body.format||"png");
    if(!["realesrgan-x4plus","realesrgan-x4plus-anime","realesr-animevideov3","realesrgan-x2plus"].includes(model)||!Number.isInteger(scale)||scale<2||scale>4||!Number.isInteger(tile)||tile<0||tile>512||(tile!==0&&tile<32)||!["png","jpg","webp"].includes(format))return response(400,{error:{code:"UPSCALE_OPTIONS_INVALID",message:"Choose an allowlisted model, scale 2–4, tile 0 or 32–512 and PNG/JPEG/WebP output."}});
    const key=String(idempotencyKey||"").trim().slice(0,180);
    if(key.length<8)return response(400,{error:{code:"IDEMPOTENCY_KEY_REQUIRED",message:"An idempotency key is required for cloud AI upscaling."}});
    if(!/^[a-f0-9]{64}$/i.test(String(source.sha256||"")))return response(422,{error:{code:"UPSCALE_SOURCE_HASH_UNAVAILABLE",message:"The source image has no verified SHA-256 fingerprint."}});
    const input={sourceAssetId,sourceSha256:source.sha256,model,scale,tile,format,rightsConfirmed:true};
    const existing=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at&owner_id=eq."+encodeURIComponent(ownerId)+"&idempotency_key=eq."+encodeURIComponent(key)+"&limit=1");
    if(Array.isArray(existing)&&existing[0]){
     const row=existing[0];
     if(row.job_type!=="media.ai-upscale"||row.project_id!==projectId||stableJson(row.input)!==stableJson(input))return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"This idempotency key was used for a different AI-upscale request."}});
     return response(200,{job:row,idempotentReplay:true});
    }
    const jobId=randomUUID();
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at",{method:"POST",body:{id:jobId,owner_id:ownerId,project_id:projectId,job_type:"media.ai-upscale",status:"queued",progress:0,input,idempotency_key:key}});
    if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==jobId||rows[0].job_type!=="media.ai-upscale"||rows[0].owner_id!==ownerId||rows[0].project_id!==projectId)throw new Error("Cloud AI-upscale job creation returned an invalid record.");
    await request("job_events",{method:"POST",body:{job_id:jobId,owner_id:ownerId,event_type:"job.queued",event_data:{jobType:"media.ai-upscale",sourceAssetId,model,scale,tile,format}},prefer:"return=minimal"});
    return response(202,{job:rows[0],idempotentReplay:false});
   }
   const benchmarkPath=path.match(/^\/api\/cloud\/upscale-benchmarks(?:\/(fixtures|runs)(?:\/([0-9a-f-]+)\/review)?)?$/i);
   if(benchmarkPath){
    const section=benchmarkPath[1]||"",runId=benchmarkPath[2]||"",projectId=String(query.projectId||"");
    if(!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Choose a valid project."}});
    const reviewRequest=Boolean(runId&&path.endsWith("/review"));
    if(await allow({ownerId,projectId,action:method==="GET"||reviewRequest?"read":"write"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Benchmark project not found or access denied."}});
    if(path==="/api/cloud/upscale-benchmarks/fixtures"&&method==="GET"){
     const fixtures=await request("upscale_benchmark_fixtures?select=id,project_id,source_asset_id,source_sha256,fixture_category,label,created_at&project_id=eq."+encodeURIComponent(projectId)+"&order=created_at.desc&limit=100");
     return response(200,{fixtures:(fixtures||[]).map(row=>({id:row.id,projectId:row.project_id,sourceAssetId:row.source_asset_id,sourceSha256:row.source_sha256,category:row.fixture_category,label:row.label,createdAt:row.created_at}))});
    }
    if(path==="/api/cloud/upscale-benchmarks/fixtures"&&method==="POST"){
     const sourceAssetId=String(body.sourceAssetId||""),category=String(body.category||"");
     if(!safeId(sourceAssetId)||!REQUIRED_UPSCALE_FIXTURE_CATEGORIES.includes(category))return response(400,{error:{code:"UPSCALE_FIXTURE_INVALID",message:"A valid source image and one of the five supported categories are required."}});
     const source=await service.assets.get({ownerId,assetId:sourceAssetId});
     if(source.projectId!==projectId||!["image/png","image/jpeg","image/webp"].includes(source.mediaType))return response(422,{error:{code:"UPSCALE_FIXTURE_SOURCE_INVALID",message:"Fixture source must be a PNG, JPEG or WebP image in this project."}});
     const id=randomUUID(),label=String(body.label||source.name||category).trim().slice(0,120);
     const rows=await request("upscale_benchmark_fixtures?select=id,project_id,source_asset_id,source_sha256,fixture_category,label,created_at",{method:"POST",body:{id,owner_id:ownerId,project_id:projectId,source_asset_id:source.id,source_sha256:source.sha256,fixture_category:category,label},prefer:"return=representation"});
     if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id)throw new Error("Cloud benchmark fixture insert did not return the expected record.");
     await request("audit_events",{method:"POST",body:{owner_id:ownerId,project_id:projectId,event_type:"upscale_benchmark.fixture_registered",subject_type:"upscale_benchmark_fixture",subject_id:id,details:{category,sourceAssetId:source.id}},prefer:"return=minimal"});
     return response(201,{fixture:{id,projectId,sourceAssetId:source.id,sourceSha256:source.sha256,category,label,createdAt:rows[0].created_at}});
    }
    if(path==="/api/cloud/upscale-benchmarks/runs"&&method==="GET"){
     const pageSize=Math.min(100,Math.max(1,Number.parseInt(String(query.limit||"50"),10)||50));
     const offset=Math.max(0,Number.parseInt(String(query.offset||"0"),10)||0);
     const select="select=id,asset_id,fixture_id,fixture_category,model,model_version,record,reviewer_id,review_decision,review_note,reviewed_at,created_at";
     const pageRows=await request("upscale_benchmark_runs?"+select+"&project_id=eq."+encodeURIComponent(projectId)+"&order=created_at.desc,id.desc&limit="+(pageSize+1)+"&offset="+offset);
     const hasMore=(pageRows||[]).length>pageSize,visibleRows=(pageRows||[]).slice(0,pageSize);
     const runs=visibleRows.map(row=>({id:row.id,assetId:row.asset_id,fixtureId:row.fixture_id,record:row.record,review:{reviewerId:row.reviewer_id,decision:row.review_decision,note:row.review_note,reviewedAt:row.reviewed_at},createdAt:row.created_at}));
     const allRecords=[],batchSize=1000,safetyLimit=50000;let reportOffset=0,evidenceTruncated=false;
     while(reportOffset<safetyLimit){
      const batch=await request("upscale_benchmark_runs?select=record&project_id=eq."+encodeURIComponent(projectId)+"&order=created_at.desc,id.desc&limit="+batchSize+"&offset="+reportOffset);
      allRecords.push(...(batch||[]).map(row=>row.record));
      if((batch||[]).length<batchSize)break;
      reportOffset+=batchSize;
     }
     if(reportOffset>=safetyLimit)evidenceTruncated=true;
     const report=compareUpscaleBenchmarkCandidates(allRecords);
     return response(200,{runs,report:{...report,recommended:evidenceTruncated?null:report.recommended,evidenceTruncated,evidenceLimit:safetyLimit},page:{offset,limit:pageSize,hasMore,nextOffset:offset+runs.length}});
    }
    if(path==="/api/cloud/upscale-benchmarks/runs"&&method==="POST"){
     const assetId=String(body.assetId||""),fixtureId=String(body.fixtureId||"");
     if(!safeId(assetId)||!safeId(fixtureId))return response(400,{error:{code:"UPSCALE_BENCHMARK_INPUT_INVALID",message:"A valid derivative asset and registered fixture are required."}});
     const fixtures=await request("upscale_benchmark_fixtures?select=id,source_asset_id,source_sha256,fixture_category&project_id=eq."+encodeURIComponent(projectId)+"&id=eq."+encodeURIComponent(fixtureId)+"&limit=1");
     const fixture=Array.isArray(fixtures)?fixtures[0]:null;
     if(!fixture)return response(404,{error:{code:"UPSCALE_FIXTURE_NOT_FOUND",message:"Benchmark fixture not found."}});
     const asset=await service.assets.get({ownerId,assetId});
     if(asset.projectId!==projectId)return response(404,{error:{code:"UPSCALE_BENCHMARK_ASSET_NOT_FOUND",message:"Derivative asset not found in this project."}});
     const record=buildUpscaleBenchmarkRecordFromAsset({outputAsset:{id:asset.id,mediaType:asset.mediaType,sha256:asset.sha256,derivativeOf:asset.derivativeOf,createdAt:asset.createdAt,metadata:asset.metadata},fixtureId:fixture.id,fixtureCategory:fixture.fixture_category});
     if(record.inputSha256!==fixture.source_sha256||asset.derivativeOf!==fixture.source_asset_id)return response(409,{error:{code:"UPSCALE_BENCHMARK_FIXTURE_MISMATCH",message:"Derivative does not originate from the exact registered fixture source."}});
     const id=randomUUID();
     const inserted=await request("upscale_benchmark_runs?select=id,created_at",{method:"POST",body:{id,owner_id:ownerId,project_id:projectId,asset_id:asset.id,fixture_id:fixture.id,fixture_category:fixture.fixture_category,model:record.model,model_version:record.modelVersion,record},prefer:"return=representation"});
     if(!Array.isArray(inserted)||inserted.length!==1||inserted[0].id!==id)throw new Error("Cloud benchmark run insert did not return the expected record.");
     await request("audit_events",{method:"POST",body:{owner_id:ownerId,project_id:projectId,event_type:"upscale_benchmark.run_registered",subject_type:"upscale_benchmark_run",subject_id:id,details:{assetId:asset.id,fixtureId:fixture.id,model:record.model,modelVersion:record.modelVersion}},prefer:"return=minimal"});
     return response(201,{run:{id,assetId:asset.id,fixtureId:fixture.id,record,review:{decision:null,reviewerId:null,reviewedAt:null},createdAt:inserted[0].created_at}});
    }
    if(runId&&path.endsWith("/review")&&method==="POST"){
     const projects=await request("projects?select=owner_id&id=eq."+encodeURIComponent(projectId)+"&limit=1");
     const projectOwner=Array.isArray(projects)?projects[0]?.owner_id:null;
     const members=await request("project_members?select=role&project_id=eq."+encodeURIComponent(projectId)+"&member_id=eq."+encodeURIComponent(ownerId)+"&limit=1");
     const role=Array.isArray(members)?members[0]?.role:null;
     if(projectOwner!==ownerId&&role!=="reviewer")return response(403,{error:{code:"BENCHMARK_REVIEWER_REQUIRED",message:"Only the project owner or an assigned reviewer can review benchmark quality."}});
     const decision=String(body.decision||"");
     if(!["reviewed_pass","reviewed_fail"].includes(decision))return response(400,{error:{code:"UPSCALE_BENCHMARK_REVIEW_INVALID",message:"Decision must be reviewed_pass or reviewed_fail."}});
     const existingRows=await request("upscale_benchmark_runs?select=id,owner_id,record,reviewer_id&project_id=eq."+encodeURIComponent(projectId)+"&id=eq."+encodeURIComponent(runId)+"&limit=1");
     const existing=Array.isArray(existingRows)?existingRows[0]:null;
     if(!existing)return response(404,{error:{code:"UPSCALE_BENCHMARK_RUN_NOT_FOUND",message:"Benchmark run not found."}});
     if(existing.reviewer_id)return response(409,{error:{code:"UPSCALE_BENCHMARK_ALREADY_REVIEWED",message:"Benchmark review is immutable once recorded."}});
     if(existing.owner_id===ownerId)return response(403,{error:{code:"UPSCALE_BENCHMARK_INDEPENDENT_REVIEW_REQUIRED",message:"The person who registered this run cannot review their own evidence."}});
     const note=String(body.note||"").trim().slice(0,2000);
     if(decision==="reviewed_fail"&&!note)return response(400,{error:{code:"UPSCALE_BENCHMARK_REVIEW_NOTE_REQUIRED",message:"A rejection requires a short note describing the quality issue."}});
     const reviewedAt=new Date().toISOString(),record={...existing.record,qualityReview:decision};
     const updated=await request("upscale_benchmark_runs?id=eq."+encodeURIComponent(runId)+"&project_id=eq."+encodeURIComponent(projectId)+"&reviewer_id=is.null",{method:"PATCH",body:{record,reviewer_id:ownerId,review_decision:decision,review_note:note,reviewed_at:reviewedAt},prefer:"return=representation"});
     if(!Array.isArray(updated)||updated.length!==1)return response(409,{error:{code:"UPSCALE_BENCHMARK_ALREADY_REVIEWED",message:"Benchmark evidence was reviewed by another user."}});
     await request("audit_events",{method:"POST",body:{owner_id:ownerId,project_id:projectId,event_type:"upscale_benchmark.quality_reviewed",subject_type:"upscale_benchmark_run",subject_id:runId,details:{decision,noteLength:note.length}},prefer:"return=minimal"});
     return response(200,{run:{id:runId,record,review:{decision,reviewerId:ownerId,reviewedAt,note}}});
    }
   }
   if(path==="/api/cloud/assets"&&method==="GET"){
    const assets=await service.assets.list({ownerId,projectId:query.projectId||null,limit:Number(query.limit)||50,offset:Number(query.offset)||0});
    return response(200,{assets});
   }
   const assetCleanupMatch=path.match(/^\\/api\\/cloud\\/assets\\/([0-9a-f-]+)\\/retry-cleanup$/i);
   if(assetCleanupMatch&&safeId(assetCleanupMatch[1])&&method==="POST"){
    if(typeof service.assets.retryCleanup!=="function")return response(501,{error:{code:"ASSET_CLEANUP_RETRY_UNAVAILABLE",message:"Cloud asset cleanup retry is not configured."}});
    const result=await service.assets.retryCleanup({ownerId,assetId:assetCleanupMatch[1]});
    return response(200,{asset:result});
   }
   if(path==="/api/cloud/timelines"&&method==="GET"){
    const timelines=await service.timelines.list({ownerId,projectId:query.projectId||null,limit:Number(query.limit)||50,offset:Number(query.offset)||0});
    return response(200,{timelines});
   }
   if(path==="/api/cloud/timelines"&&method==="POST"){
    const timeline=await service.timelines.create({ownerId,projectId:body.projectId||null,name:body.name||"Untitled timeline",timeline:body.timeline,otio:body.otio??null});
    return response(201,{timeline});
   }
   const assetMatch=path.match(/^\/api\/cloud\/assets\/([0-9a-f-]+)$/i);
   if(assetMatch&&safeId(assetMatch[1])){
    if(method==="GET"){
     const signed=await service.assets.createSignedUrl({ownerId,assetId:assetMatch[1],expiresIn:300});
     return response(200,{asset:signed.asset,url:signed.url,expiresIn:300});
    }
    if(method==="DELETE"){
     const result=await service.assets.softDelete({ownerId,assetId:assetMatch[1]});
     return response(200,{asset:result});
    }
   }
   if(path==="/api/cloud/transformations/readiness"&&method==="GET"){
    const projectId=String(query.projectId||"");
    if(!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Choose a valid project."}});
    if(await allow({ownerId,projectId,action:"read"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});
    const evidence=await transformationReadiness({ownerId,projectId});
    return response(200,{readiness:buildTransformationReadinessReport(evidence)});
   }
   const transformationOps=new Set(["vehicle_replace","wardrobe_replace","object_replace","background_replace","person_replace","style_transfer","object_remove","relight"]);
   const preservationOptions=new Set(["camera_motion","timing","composition","source_audio","subject_identity","pose","lighting","background"]);
   const mapTransformation=row=>{
    const input=row.input||{},approval=row.estimated_cost||{};
    return {id:row.id,projectId:row.project_id,sourceAssetId:input.sourceAssetId,operation:input.operation,prompt:input.prompt,durationSeconds:input.durationSeconds,referenceAssetIds:input.referenceAssetIds||[],preservation:input.preservation||[],status:row.approved_at?"approved":row.status==="draft"?"draft":row.status,rightsConfirmed:input.rightsConfirmed===true,subjectConsentConfirmed:input.subjectConsentConfirmed===true,approval:row.approved_at?{id:approval.approvalId,planHash:approval.planHash||null,estimatedCostMicros:approval.estimatedCostMicros,approvedBudgetMicros:approval.approvedBudgetMicros,currency:approval.currency,adapterId:approval.adapterId,capability:approval.capability,approvedAt:row.approved_at}:null,createdAt:row.created_at,updatedAt:row.updated_at};
   };
   if(path==="/api/cloud/transformations"&&method==="GET"){
    const projectId=String(query.projectId||"");
    if(!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Choose a valid project."}});
    if(await allow({ownerId,projectId,action:"read"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at&project_id=eq."+encodeURIComponent(projectId)+"&job_type=eq.video.transform.plan&order=created_at.desc&limit=100");
    return response(200,{plans:(Array.isArray(rows)?rows:[]).filter(row=>row.owner_id===ownerId||row.project_id===projectId).map(mapTransformation)});
   }
   if(path==="/api/cloud/transformations"&&method==="POST"){
    if(!body||typeof body!=="object"||Array.isArray(body))return response(400,{error:{code:"TRANSFORMATION_BODY_INVALID",message:"Transformation request must be a JSON object."}});
    const projectId=String(body.projectId||""),sourceAssetId=String(body.sourceAssetId||""),operation=String(body.operation||"");
    if(!safeId(projectId)||await allow({ownerId,projectId,action:"write"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or editor access required."}});
    if(!transformationOps.has(operation))return response(400,{error:{code:"TRANSFORMATION_OPERATION_INVALID",message:"Choose a supported transformation."}});
    const prompt=typeof body.prompt==="string"?body.prompt.trim().slice(0,12000):"";
    const duration=Number(body.durationSeconds);
    if(prompt.length<8||!Number.isInteger(duration)||duration<1||duration>30)return response(400,{error:{code:"TRANSFORMATION_INPUT_INVALID",message:"Provide an edit prompt and a duration from 1 to 30 seconds."}});
    if(body.rightsConfirmed!==true)return response(403,{error:{code:"MEDIA_RIGHTS_REQUIRED",message:"Confirm rights to use the source and reference media."}});
    if(operation==="person_replace"&&body.subjectConsentConfirmed!==true)return response(403,{error:{code:"SUBJECT_CONSENT_REQUIRED",message:"Explicit subject consent is required for person replacement."}});
    const source=await service.assets.get({ownerId,assetId:sourceAssetId});
    if(source.projectId!==projectId||!source.mediaType.startsWith("video/"))return response(422,{error:{code:"SOURCE_VIDEO_INVALID",message:"Source video must be an asset in this project."}});
    const refs=Array.isArray(body.referenceAssetIds)?[...new Set(body.referenceAssetIds.map(String))]:[];
    if(refs.length>4)return response(400,{error:{code:"REFERENCE_LIMIT_EXCEEDED",message:"Use no more than four reference images."}});
    for(const id of refs){const asset=await service.assets.get({ownerId,assetId:id});if(asset.projectId!==projectId||!asset.mediaType.startsWith("image/"))return response(422,{error:{code:"REFERENCE_ASSET_INVALID",message:"Every reference must be a project image asset."}});}
    const preservation=Array.isArray(body.preservation)?[...new Set(body.preservation.filter(value=>preservationOptions.has(value)))]:[];
    const key=String(idempotencyKey||"").trim().slice(0,180);
    if(key.length<8)return response(400,{error:{code:"IDEMPOTENCY_KEY_REQUIRED",message:"An idempotency key is required."}});
    const input={projectId,sourceAssetId,operation,prompt,durationSeconds:duration,referenceAssetIds:refs,preservation,rightsConfirmed:true,subjectConsentConfirmed:body.subjectConsentConfirmed===true};
    const existing=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at&owner_id=eq."+encodeURIComponent(ownerId)+"&idempotency_key=eq."+encodeURIComponent(key)+"&limit=1");
    if(Array.isArray(existing)&&existing[0]){
     const row=existing[0];
     if(row.job_type!=="video.transform.plan"||stableJson(row.input)!==stableJson(input))return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"This idempotency key was used for a different transformation."}});
     return response(200,{plan:mapTransformation(row),idempotentReplay:true});
    }
    const id=randomUUID(),rows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at",{method:"POST",body:{id,owner_id:ownerId,project_id:projectId,job_type:"video.transform.plan",status:"draft",progress:0,input,idempotency_key:key}});
    if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id||rows[0].owner_id!==ownerId||rows[0].project_id!==projectId||rows[0].status!=="draft")throw new Error("Cloud transformation draft creation returned an invalid receipt.");
    await request("job_events",{method:"POST",body:{job_id:id,owner_id:ownerId,event_type:"transformation.draft_created",event_data:{operation,sourceAssetId}}});
    return response(201,{plan:mapTransformation(rows[0]),idempotentReplay:false});
   }
   const cloudTransformationMatch=path.match(/^\/api\/cloud\/transformations\/([0-9a-f-]+)(?:\/(approve|submit))?$/i);
   if(cloudTransformationMatch&&safeId(cloudTransformationMatch[1])){
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at&id=eq."+encodeURIComponent(cloudTransformationMatch[1])+"&job_type=eq.video.transform.plan&limit=1");
    const row=Array.isArray(rows)?rows[0]:null;
    if(!row||await allow({ownerId,projectId:row.project_id,action:"read"})!==true)return response(404,{error:{code:"TRANSFORMATION_NOT_FOUND",message:"Transformation plan not found."}});
    if(!cloudTransformationMatch[2]&&method==="GET")return response(200,{plan:mapTransformation(row)});
    if(cloudTransformationMatch[2]==="approve"&&method==="POST"){
     if(await allow({ownerId,projectId:row.project_id,action:"write"})!==true)return response(403,{error:{code:"EDITOR_REQUIRED",message:"Owner or editor access is required."}});
     if(row.status!=="draft"||row.approved_at)return response(409,{error:{code:"TRANSFORMATION_STATE_CONFLICT",message:"Only an unapproved draft can be approved."}});
     const estimate=body?.estimatedCostMicros,budget=body?.approvedBudgetMicros,currency=String(body?.currency||"").toUpperCase(),adapterId=String(body?.adapterId||"").trim(),capability=String(body?.capability||"").trim();
     if(!Number.isSafeInteger(estimate)||estimate<0||!Number.isSafeInteger(budget)||budget<estimate||! /^[A-Z]{3}$/.test(currency)||!adapterId||!capability)return response(400,{error:{code:"TRANSFORMATION_BUDGET_INVALID",message:"Provide a known estimate, a covering budget, currency, adapter and capability."}});
     const planHash=createHash("sha256").update(stableJson(row.input||{})).digest("hex");
     const approval={schemaVersion:1,approvalId:randomUUID(),planHash,estimatedCostMicros:estimate,approvedBudgetMicros:budget,currency,adapterId,capability};
     const updated=await request("jobs?id=eq."+encodeURIComponent(row.id)+"&status=eq.draft&approved_at=is.null",{method:"PATCH",body:{status:"awaiting_approval",estimated_cost:approval,approved_by:ownerId,approved_at:new Date().toISOString(),updated_at:new Date().toISOString()}});
     if(!Array.isArray(updated)||updated.length!==1)return response(409,{error:{code:"TRANSFORMATION_STATE_CONFLICT",message:"Transformation plan changed while approval was recorded."}});
     await request("job_events",{method:"POST",body:{job_id:row.id,owner_id:row.owner_id,event_type:"transformation.approved",event_data:{approvalId:approval.approvalId,planHash,estimatedCostMicros:estimate,currency}}});
     return response(200,{plan:mapTransformation(updated[0])});
    }
    if(cloudTransformationMatch[2]==="submit"&&method==="POST"){
     if(await allow({ownerId,projectId:row.project_id,action:"write"})!==true)return response(403,{error:{code:"EDITOR_REQUIRED",message:"Owner or editor access is required."}});
     if(!row.approved_at||!row.approved_by)return response(409,{error:{code:"TRANSFORMATION_APPROVAL_REQUIRED",message:"Approve the plan and budget before submission."}});
     const approvedPlanHash=row.estimated_cost?.planHash;
     const currentPlanHash=createHash("sha256").update(stableJson(row.input||{})).digest("hex");
     if(typeof approvedPlanHash!=="string"||!/^[a-f0-9]{64}$/.test(approvedPlanHash)||approvedPlanHash!==currentPlanHash)return response(409,{error:{code:"TRANSFORMATION_PLAN_CHANGED",message:"The approved transformation no longer matches its immutable plan fingerprint. Create and approve a new plan."}});
     return response(409,{error:{code:"TRANSFORMATION_ADAPTER_UNAVAILABLE",message:"No verified video-transformation adapter is enabled. No provider request or charge was made."}});
    }
   }
   const deliveryApprovalMatch=path.match(/^\/api\/cloud\/jobs\/([0-9a-f-]+)\/delivery-approval$/i);
   if(deliveryApprovalMatch&&safeId(deliveryApprovalMatch[1])&&(method==="GET"||method==="POST")){
    const jobRows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,output&id=eq."+encodeURIComponent(deliveryApprovalMatch[1])+"&limit=1");
    const job=Array.isArray(jobRows)?jobRows[0]:null;
    if(!job||job.job_type!=="timeline.render"||!job.project_id)return response(404,{error:{code:"DELIVERY_JOB_NOT_FOUND",message:"A completed project timeline render was not found."}});
    if(await allow({ownerId,projectId:job.project_id,action:method==="POST"?"write":"read"})!==true)return response(404,{error:{code:"DELIVERY_JOB_NOT_FOUND",message:"Delivery review access was not found."}});
    const output=job.output&&typeof job.output==="object"?job.output:{};
    const receipt=output.deliveryManifest;
    const timelineInput=job.input&&typeof job.input==="object"?job.input:{};
    if(job.status!=="succeeded"||!receipt||!verifyDeliveryManifest(receipt)||receipt.timelineId!==timelineInput.timelineId||receipt.timelineRevision!==Number(timelineInput.timelineRevision)||receipt.outputAsset!==(output.outputAsset?.id||output.outputAssetId)||receipt.sha256!==output.sha256)
     return response(409,{error:{code:"DELIVERY_EVIDENCE_UNVERIFIED",message:"This render has no valid, revision-matched delivery receipt. Approval is blocked."}});
    const events=await request("job_events?select=id,event_type,event_data,created_at&job_id=eq."+encodeURIComponent(job.id)+"&order=id.asc");
    const approvals=(Array.isArray(events)?events:[]).filter(event=>event.event_type==="delivery.reviewed"&&event.event_data?.fingerprint===receipt.fingerprint);
    if(method==="GET")return response(200,{receipt,approval:approvals.length?{...approvals.at(-1).event_data,createdAt:approvals.at(-1).created_at}:null,approvalHistory:approvals.map(event=>({id:event.id,...event.event_data,createdAt:event.created_at}))});
    if(job.owner_id===ownerId)return response(403,{error:{code:"INDEPENDENT_REVIEW_REQUIRED",message:"The render creator cannot approve their own delivery. A different authorized project reviewer is required."}});
    if(approvals.some(event=>event.event_data?.reviewerId===ownerId))return response(409,{error:{code:"DELIVERY_ALREADY_REVIEWED",message:"This reviewer has already recorded a decision for this exact delivery fingerprint."}});
    const decision=String(body.decision||"");
    if(!["approved","rejected","changes_requested"].includes(decision))return response(400,{error:{code:"DELIVERY_DECISION_INVALID",message:"Choose approved, rejected or changes_requested."}});
    const note=typeof body.note==="string"?body.note.trim():"";
    if(note.length>2000)return response(400,{error:{code:"DELIVERY_NOTE_TOO_LONG",message:"Review notes must be 2,000 characters or fewer."}});
    if(decision==="approved"&&output.deliveryReport?.status==="needs-attention")return response(409,{error:{code:"DELIVERY_VALIDATION_BLOCKED",message:"A delivery with blocking validation errors cannot be approved."}});
    if(decision==="approved"&&output.qualityReport?.status==="needs-attention")return response(409,{error:{code:"MEDIA_QUALITY_BLOCKED",message:"A render with blocking media-quality errors cannot be approved."}});
    if(decision==="approved"&&output.qualityReport?.status==="review"&&Number(output.qualityReport.counts?.warnings)>0&&!note)return response(400,{error:{code:"QUALITY_ACKNOWLEDGEMENT_REQUIRED",message:"Record a review note acknowledging the media-quality warnings before approving this delivery."}});
    const eventData={schemaVersion:1,decision,fingerprint:receipt.fingerprint,timelineId:receipt.timelineId,timelineRevision:receipt.timelineRevision,outputAsset:receipt.outputAsset,reviewerId:ownerId,note,reviewedAt:new Date().toISOString()};
    await request("job_events",{method:"POST",body:{job_id:job.id,owner_id:ownerId,event_type:"delivery.reviewed",event_data:eventData}});
    return response(201,{approval:eventData});
   }
   const deliveryPackageMatch=path.match(/^\/api\/cloud\/jobs\/([0-9a-f-]+)\/delivery-package$/i);
   if(deliveryPackageMatch&&safeId(deliveryPackageMatch[1])&&method==="GET"){
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,output&id=eq."+encodeURIComponent(deliveryPackageMatch[1])+"&limit=1");
    const job=Array.isArray(rows)?rows[0]:null;
    if(!job||job.job_type!=="timeline.render"||!job.project_id)return response(404,{error:{code:"DELIVERY_JOB_NOT_FOUND",message:"A completed project timeline render was not found."}});
    if(await allow({ownerId,projectId:job.project_id,action:"read"})!==true)return response(404,{error:{code:"DELIVERY_JOB_NOT_FOUND",message:"Delivery package access was not found."}});
    const output=job.output&&typeof job.output==="object"?job.output:{},receipt=output.deliveryManifest,input=job.input&&typeof job.input==="object"?job.input:{};
    if(job.status!=="succeeded"||!receipt||!verifyDeliveryManifest(receipt)||receipt.timelineId!==input.timelineId||receipt.timelineRevision!==Number(input.timelineRevision)||receipt.outputAsset!==(output.outputAsset?.id||output.outputAssetId)||receipt.sha256!==output.sha256)
     return response(409,{error:{code:"DELIVERY_EVIDENCE_UNVERIFIED",message:"A valid revision-matched delivery receipt is required to package this render."}});
    if(!service.assets||typeof service.assets.get!=="function"||typeof service.assets.createSignedUrl!=="function")return response(503,{error:{code:"DELIVERY_PACKAGE_UNAVAILABLE",message:"Private asset download is not available."}});
    const asset=await service.assets.get({ownerId,assetId:receipt.outputAsset});
    if(!asset||asset.id!==receipt.outputAsset||asset.projectId!==job.project_id||asset.sha256!==receipt.sha256||asset.size!==receipt.byteSize||asset.mediaType!==receipt.mediaType)
     return response(409,{error:{code:"DELIVERY_ASSET_MISMATCH",message:"The published master asset does not match its delivery receipt."}});
    const signed=await service.assets.createSignedUrl({ownerId,assetId:receipt.outputAsset,expiresIn:300});
    if(!signed?.asset||signed.asset.id!==asset.id||signed.asset.sha256!==receipt.sha256||Number(signed.asset.size)!==receipt.byteSize||signed.asset.projectId!==job.project_id)return response(409,{error:{code:"DELIVERY_SIGNED_ASSET_MISMATCH",message:"The private download ticket does not reference the verified master asset."}});
    let downloadUrl;try{downloadUrl=new URL(signed.url);if(downloadUrl.protocol!=="https:"||downloadUrl.username||downloadUrl.password||downloadUrl.hash)throw new Error();}catch{return response(502,{error:{code:"DELIVERY_DOWNLOAD_URL_INVALID",message:"The private storage service returned an unsafe download URL."}});}
    const events=await request("job_events?select=id,event_type,event_data,created_at&job_id=eq."+encodeURIComponent(job.id)+"&order=id.asc");
    const approvals=(Array.isArray(events)?events:[]).filter(event=>event.event_type==="delivery.reviewed"&&event.event_data?.fingerprint===receipt.fingerprint).map(event=>({id:event.id,...event.event_data,createdAt:event.created_at}));
    const deliveryPackage=createDeliveryPackage({jobId:job.id,projectId:job.project_id,timelineId:receipt.timelineId,timelineRevision:receipt.timelineRevision,master:{assetId:asset.id,filename:asset.name,mediaType:asset.mediaType,byteSize:asset.size,sha256:asset.sha256,downloadUrl:downloadUrl.href,downloadUrlExpiresInSeconds:300},deliveryReceipt:receipt,renderManifest:receipt.renderManifest,deliveryReport:receipt.deliveryReport,qualityReport:output.qualityReport||null,reviewHistory:approvals});
    return response(200,{deliveryPackage});
   }
   const jobMatch=path.match(/^\/api\/cloud\/jobs\/([0-9a-f-]+)(?:\/(events))?$/i);
   if(jobMatch&&safeId(jobMatch[1])&&method==="GET"){
    const jobRows=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,attempt_count,created_at,updated_at,completed_at&id=eq."+encodeURIComponent(jobMatch[1])+"&limit=1");
    const job=Array.isArray(jobRows)?jobRows[0]:null;
    if(!job)return response(404,{error:{code:"JOB_NOT_FOUND",message:"Job not found."}});
    if(job.project_id){if(await allow({ownerId,projectId:job.project_id,action:"read"})!==true)return response(404,{error:{code:"JOB_NOT_FOUND",message:"Job not found."}});}
    else if(job.owner_id!==ownerId)return response(404,{error:{code:"JOB_NOT_FOUND",message:"Job not found."}});
    if(jobMatch[2]){
     const events=await request("job_events?select=id,event_type,event_data,created_at&job_id=eq."+encodeURIComponent(job.id)+"&order=id.asc");
     return response(200,{events:Array.isArray(events)?events.map(event=>({id:event.id,type:event.event_type,data:event.event_data,createdAt:event.created_at})):[]});
    }
    return response(200,{job});
   }
   const handoffMatch=path.match(/^\/api\/cloud\/timelines\/([0-9a-f-]+)\/handoff$/i);
   if(handoffMatch&&safeId(handoffMatch[1])&&method==="POST"){
    const timelineId=handoffMatch[1],assetId=String(body.assetId||""),jobId=String(body.jobId||""),trackId=String(body.trackId||""),clipId=String(body.clipId||"");
    if(!safeId(assetId)||!safeId(jobId)||!trackId||trackId.length>180||!clipId||clipId.length>180)return response(400,{error:{code:"HANDOFF_INPUT_INVALID",message:"Provide valid asset, job, track and clip identifiers."}});
    const timeline=await service.timelines.get({ownerId,timelineId});
    if(!timeline)return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
    if(await allow({ownerId,projectId:timeline.projectId,action:"write"})!==true)return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found or editor access required."}});
    if(!Number.isInteger(body.expectedRevision)||body.expectedRevision<1)return response(400,{error:{code:"HANDOFF_REVISION_REQUIRED",message:"Provide the timeline revision you reviewed."}});
    if(body.expectedRevision!==timeline.revision)return response(409,{error:{code:"REVISION_CONFLICT",message:"Timeline changed since it was loaded. Refresh and retry."}});
    const asset=await service.assets.get({ownerId,assetId});
    if(!asset||asset.projectId!==timeline.projectId)return response(404,{error:{code:"HANDOFF_ASSET_NOT_FOUND",message:"Generated asset not found in this project."}});
    const metadata=asset.metadata||{},verification=metadata.mediaVerification||{},probe=metadata.probe||{},format=probe.format||{};
    if(metadata.generated!==true||metadata.jobId!==jobId||verification.status!=="passed"||verification.readable!==true||verification.sha256!==asset.sha256)
     return response(422,{error:{code:"HANDOFF_ASSET_UNVERIFIED",message:"Asset must have a matching generation job and server-recorded readability/checksum verification before handoff."}});
    const mediaPrefix=String(asset.mediaType||"").split("/")[0].toLowerCase();
    const kind=mediaPrefix==="video"?"video":mediaPrefix==="audio"?"audio":mediaPrefix==="image"?"image":null;
    if(!kind)return response(422,{error:{code:"HANDOFF_MEDIA_UNSUPPORTED",message:"This media type cannot be placed on the timeline."}});
    const track=timeline.timeline.tracks.find(item=>item.id===trackId);
    if(!track)return response(422,{error:{code:"HANDOFF_TRACK_NOT_FOUND",message:"Choose an existing track."}});
    if(track.locked)return response(422,{error:{code:"HANDOFF_TRACK_LOCKED",message:"The target track is locked."}});
    if((kind==="audio"&&track.kind!=="audio")||(kind==="video"&&track.kind!=="video")||(kind==="image"&&track.kind!=="video"&&track.kind!=="overlay"))
     return response(422,{error:{code:"HANDOFF_TRACK_INCOMPATIBLE",message:"The target track cannot contain this media type."}});
    const duration=kind==="image"?Number(body.durationSeconds):Number(format.duration);
    if(!Number.isFinite(duration)||duration<=0||duration>3600)return response(422,{error:{code:"HANDOFF_DURATION_UNVERIFIED",message:"A valid source duration is required; for still images, specify an explicit clip duration."}});
    const fps=timeline.timeline.frameRate.numerator/timeline.timeline.frameRate.denominator;
    if(!Number.isFinite(fps)||fps<=0)return response(422,{error:{code:"HANDOFF_TIMELINE_RATE_INVALID",message:"Timeline frame rate is invalid."}});
    const startSeconds=Number(body.playheadSeconds);
    if(!Number.isFinite(startSeconds)||startSeconds<0||startSeconds>86400)return response(400,{error:{code:"HANDOFF_PLAYHEAD_INVALID",message:"Playhead must be a finite time between 0 and 24 hours."}});
    const existing=track.clips.find(item=>item.id===clipId);
    if(existing){
     if(existing.assetId===assetId&&existing.metadata?.generationJobId===jobId)return response(200,{timeline,idempotentReplay:true});
     return response(409,{error:{code:"HANDOFF_CLIP_CONFLICT",message:"Clip ID already exists for a different edit."}});
    }
    const sourceTimebase=1000,sourceDurationTicks=Math.round(duration*sourceTimebase),startFrame=Math.round(startSeconds*fps);
    if(sourceDurationTicks<=0)return response(422,{error:{code:"HANDOFF_DURATION_INVALID",message:"Media duration is too short for the supported timebase."}});
    const start=startFrame/fps,end=start+sourceDurationTicks/sourceTimebase;
    for(const clip of track.clips){
     const clipStart=clip.timelineStart.value/clip.timelineStart.rate,clipEnd=clipStart+clip.duration.value/clip.duration.rate;
     if(start<clipEnd-1e-6&&end>clipStart+1e-6)return response(409,{error:{code:"HANDOFF_OVERLAP",message:"Choose an empty position or another track; existing clips will not be replaced."}});
    }
    const clip={id:clipId,assetId,name:String(body.clipName||asset.name||("Generated "+kind)).slice(0,180),sourceRange:{start:{value:0,rate:sourceTimebase},duration:{value:sourceDurationTicks,rate:sourceTimebase}},timelineStart:{value:startFrame,rate:fps},duration:{value:sourceDurationTicks,rate:sourceTimebase},enabled:true,metadata:{origin:"generated-media-handoff",generationJobId:jobId,verifiedSha256:asset.sha256,sourceProjectId:timeline.projectId}};
    const updatedDocument={...timeline.timeline,tracks:timeline.timeline.tracks.map(item=>item.id===trackId?{...item,clips:[...item.clips,clip].sort((a,b)=>a.timelineStart.value/a.timelineStart.rate-b.timelineStart.value/b.timelineStart.rate)}:item)};
    const otio=body.otio??timeline.otio??null;
    const saved=await service.timelines.update({ownerId,timelineId,expectedRevision:timeline.revision,timeline:updatedDocument,otio});
    return response(200,{timeline:saved,idempotentReplay:false});
   }
   const previewMatch=path.match(/^\/api\/cloud\/timelines\/([0-9a-f-]+)\/preview\/([0-9a-f-]+)$/i);
   if(previewMatch&&safeId(previewMatch[1])&&safeId(previewMatch[2])&&method==="GET"){
    const timelineId=previewMatch[1],assetId=previewMatch[2];
    const timeline=await service.timelines.get({ownerId,timelineId});
    if(!timeline)return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
    if(await allow({ownerId,projectId:timeline.projectId,action:"read"})!==true)return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
    if(query.revision!==undefined&&String(query.revision)!==String(timeline.revision))return response(409,{error:{code:"REVISION_CONFLICT",message:"Timeline changed since this preview was requested. Refresh the timeline."}});
    const referenced=(timeline.timeline?.tracks||[]).some(track=>track?.enabled!==false&&(track?.clips||[]).some(clip=>clip?.enabled!==false&&clip?.assetId===assetId));
    if(!referenced)return response(404,{error:{code:"PREVIEW_ASSET_NOT_FOUND",message:"This asset is not part of the requested timeline."}});
    const asset=await service.assets.get({ownerId,assetId});
    if(!asset||asset.projectId!==(timeline.projectId||null))return response(404,{error:{code:"PREVIEW_ASSET_NOT_FOUND",message:"Preview asset not found in this project."}});
    const signed=await service.assets.createSignedUrl({ownerId,assetId,expiresIn:300});
    return response(200,{preview:{timelineId, timelineRevision:timeline.revision,asset:signed.asset,url:signed.url,expiresIn:300,cacheControl:"no-store"}});
   }
   const match=path.match(/^\/api\/cloud\/timelines\/([0-9a-f-]+)(?:\/(render))?$/i);
   if(!match||!safeId(match[1]))return null;
   const timelineId=match[1];
   if(match[2]==="render"&&method==="POST"){
    if(await allow({ownerId,projectId:(await service.timelines.get({ownerId,timelineId}))?.projectId||null,action:"write"})!==true)
     return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found or editor access required."}});
    const timeline=await service.timelines.get({ownerId,timelineId});
    if(!timeline)return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
    const key=typeof idempotencyKey==="string"?idempotencyKey.slice(0,180):"";
    if(key){
     const existing=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at&idempotency_key=eq."+encodeURIComponent(key)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&limit=1");
     if(Array.isArray(existing)&&existing[0]){
      const row=existing[0],input=row.input||{};
      if(row.job_type!=="timeline.render"||input.timelineId!==timelineId||input.timelineRevision!==timeline.revision)return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"This idempotency key belongs to a different render request."}});
      return response(200,{job:row,idempotentReplay:true});
     }
    }
    const jobId=randomUUID(),input={timelineId,timelineRevision:timeline.revision};
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at",{method:"POST",body:{id:jobId,owner_id:ownerId,project_id:timeline.projectId,job_type:"timeline.render",status:"queued",progress:0,input,idempotency_key:key||null}});
    if(!Array.isArray(rows)||rows.length!==1||rows[0].owner_id!==ownerId||rows[0].job_type!=="timeline.render")throw new Error("Cloud render job creation returned an invalid record.");
    await request("job_events",{method:"POST",body:{job_id:jobId,owner_id:ownerId,event_type:"job.queued",event_data:{jobType:"timeline.render",timelineId,timelineRevision:timeline.revision}},prefer:"return=minimal"});
    return response(202,{job:rows[0]});
   }
   if(method==="GET"&&!match[2]){
    const timeline=await service.timelines.get({ownerId,timelineId});
    return timeline?response(200,{timeline}):response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
   }
   if(method==="PUT"&&!match[2]){
    const timeline=await service.timelines.update({ownerId,timelineId,expectedRevision:Number(body.expectedRevision),timeline:body.timeline,otio:body.otio});
    return response(200,{timeline});
   }
   return null;
  }catch(error){
   if(error.code==="CLOUD_TIMELINE_API_DATABASE_ERROR"&&error.status===409&&error.databaseCode==="23505"&&path==="/api/cloud/upscale-benchmarks/fixtures")return response(409,{error:{code:"UPSCALE_FIXTURE_EXISTS",message:"This source asset is already registered as a fixture in this project."}});
   if(error.code==="CLOUD_TIMELINE_API_DATABASE_ERROR"&&error.status===409&&error.databaseCode==="23505"&&path==="/api/cloud/upscale-benchmarks/runs")return response(409,{error:{code:"UPSCALE_BENCHMARK_ALREADY_REGISTERED",message:"This derivative is already registered for the selected fixture."}});
   if(error.code==="CLOUD_TIMELINE_API_DATABASE_ERROR"&&error.status===409&&error.databaseCode==="23505")return response(409,{error:{code:"DELIVERY_ALREADY_REVIEWED",message:"A review decision already exists for this reviewer and delivery fingerprint."}});
   if(error.code==="CLOUD_PROJECT_NOT_FOUND"||error.code==="CLOUD_PROJECT_ACCESS_DENIED")return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});
   if(error.code==="CLOUD_PROJECT_REVISION_CONFLICT")return response(409,{error:{code:"REVISION_CONFLICT",message:"Project changed since it was loaded. Refresh and retry."}});
   if(error.code==="CLOUD_ASSET_NOT_FOUND")return response(404,{error:{code:"ASSET_NOT_FOUND",message:"Asset not found."}});
   if(error.code==="CLOUD_TIMELINE_NOT_FOUND")return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
   if(error.code==="CLOUD_ASSET_ACCESS_DENIED")return response(404,{error:{code:"ASSET_NOT_FOUND",message:"Asset not found."}});
   if(error.code==="CLOUD_TIMELINE_ACCESS_DENIED")return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
   if(error.code==="CLOUD_TIMELINE_REVISION_CONFLICT")return response(409,{error:{code:"REVISION_CONFLICT",message:"Timeline changed since it was loaded. Refresh and retry."}});
   if(error.code==="CLOUD_TIMELINE_INVALID")return response(422,{error:{code:"TIMELINE_INVALID",message:error.message,issues:error.issues||[]}});
   if(error.status===409)return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"The render request conflicts with an existing job."}});
   throw error;
  }
 }
 async function checkReadiness(){
  const required=["projects","project_members","assets","timelines","jobs","job_events"];
  for(const table of required){
   const rows=await request(table+"?select=id&limit=0");
   if(!Array.isArray(rows))throw new Error("Cloud timeline API readiness check failed for table "+table+".");
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const result=await fetchImpl(base+"/storage/v1/bucket/executive-visuals-media",{headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,accept:"application/json"},signal:controller.signal});
   if(!result.ok)throw new Error("Cloud timeline API private storage bucket is unavailable (HTTP "+result.status+").");
   const bucket=await result.json();
   if(bucket.public!==false)throw new Error("Cloud timeline API refuses a media bucket that is not confirmed private.");
  }catch(error){if(error?.name==="AbortError")throw new Error("Cloud timeline API storage readiness check timed out.");throw error;}
  finally{clearTimeout(timer);}
  return{ready:true,storage:"private",schema:"executive_visuals"};
 }
 async function uploadAsset({req,ownerId,projectId=null,originalName="upload",mediaType="application/octet-stream"}={}){
  if(!safeId(ownerId))return response(401,{error:{code:"AUTH_REQUIRED",message:"A verified account identity is required."}});
  if(projectId!==null&&projectId!==undefined&&projectId!==""&&!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Project ID must be a UUID."}});
  projectId=projectId||null;mediaType=String(mediaType).split(";")[0].trim().toLowerCase();
  const extensions={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","video/x-matroska":"mkv","audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/ogg":"ogg","application/pdf":"pdf","text/plain":"txt","application/x-subrip":"srt","text/vtt":"vtt","application/json":"json"};
  if(!extensions[mediaType])return response(415,{error:{code:"UNSUPPORTED_MEDIA_TYPE",message:"This media type is not accepted."}});
  if(!req||typeof req[Symbol.asyncIterator]!=="function")return response(400,{error:{code:"UPLOAD_STREAM_REQUIRED",message:"A binary upload stream is required."}});
  let name="upload";try{name=decodeURIComponent(String(originalName||"upload"));}catch{return response(400,{error:{code:"INVALID_FILE_NAME",message:"File name header is malformed."}});}
  name=basename(name.replace(/[\\/\u0000-\u001f\u007f]/g,"_")).normalize("NFKC").replace(/[^\p{L}\p{N}._() -]/gu,"_").slice(0,180)||"upload";
  const declared=Number(req.headers?.["content-length"]||0);if(declared>maxUploadBytes)return response(413,{error:{code:"UPLOAD_TOO_LARGE",message:"Upload exceeds the configured size limit."}});
  const directory=await mkdtemp(join(tempRoot,"ev-cloud-upload-")),filePath=join(directory,randomUUID()+"."+extensions[mediaType]);
  let size=0,header=Buffer.alloc(0);
  const meter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>maxUploadBytes){callback(Object.assign(new Error("Upload exceeds the configured size limit."),{code:"UPLOAD_TOO_LARGE"}));return;}if(header.length<32)header=Buffer.concat([header,chunk.subarray(0,32-header.length)]);callback(null,chunk);}});
  try{
   await pipeline(req,meter,createWriteStream(filePath,{flags:"wx"}));
   if(size<1)return response(400,{error:{code:"EMPTY_UPLOAD",message:"Empty uploads are not accepted."}});
   const valid=mediaType==="image/png"?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    :mediaType==="image/jpeg"?header[0]===255&&header[1]===216&&header[2]===255
    :mediaType==="image/webp"?header.subarray(0,4).toString()==="RIFF"&&header.subarray(8,12).toString()==="WEBP"
    :mediaType==="image/gif"?["GIF87a","GIF89a"].includes(header.subarray(0,6).toString())
    :["video/mp4","video/quicktime","audio/mp4"].includes(mediaType)?header.subarray(4,8).toString()==="ftyp"
    :["video/webm","video/x-matroska"].includes(mediaType)?header.subarray(0,4).equals(Buffer.from([26,69,223,163]))
    :["audio/wav","audio/x-wav"].includes(mediaType)?header.subarray(0,4).toString()==="RIFF"&&header.subarray(8,12).toString()==="WAVE"
    :mediaType==="audio/ogg"?header.subarray(0,4).toString()==="OggS"
    :mediaType==="audio/mpeg"?header.subarray(0,3).toString()==="ID3"||(header[0]===255&&(header[1]&224)===224)
    :mediaType==="application/pdf"?header.subarray(0,5).toString()==="%PDF-"
    :!header.includes(0);
   if(!valid)return response(415,{error:{code:"MEDIA_SIGNATURE_MISMATCH",message:"File signature does not match the declared media type."}});
   const captionFile=extname(name).toLowerCase();
   const captionValidation=captionFile===".srt"&&(mediaType==="text/plain"||mediaType==="application/x-subrip")?validateSrt(size>2*1024*1024?"x".repeat(2*1024*1024+1):await readFile(filePath,"utf8")):captionFile===".vtt"&&mediaType==="text/vtt"?validateWebVtt(size>2*1024*1024?"x".repeat(2*1024*1024+1):await readFile(filePath,"utf8")):null;
   const metadata={ingest:"cloud-api",...(captionValidation?{captionValidation}:{})};
   const asset=await service.assets.createFromFile({ownerId,projectId,originalName:name,mediaType,filePath,metadata});
   return response(201,{asset});
  }catch(error){
   if(error.code==="UPLOAD_TOO_LARGE")return response(413,{error:{code:error.code,message:error.message}});
   if(error.code==="CLOUD_ASSET_ACCESS_DENIED"||error.code==="CLOUD_ASSET_NOT_FOUND")return response(404,{error:{code:"ASSET_NOT_FOUND",message:"Asset not found."}});
   throw error;
  }finally{await rm(directory,{recursive:true,force:true}).catch(()=>{});}
 }
 return Object.freeze({handle,uploadAsset,checkReadiness});
}
