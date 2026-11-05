import { createHash, randomUUID } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const seconds=value=>Number(value?.value)/Number(value?.rate);
const stableJson=value=>Array.isArray(value)?"["+value.map(stableJson).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stableJson(value[key])).join(",")+"}":JSON.stringify(value);
const timelineHash=(timeline,otio=null)=>createHash("sha256").update(stableJson({timeline,otio:otio??null})).digest("hex");

function validateDocument(document){
  const issues=[];
  if(!object(document))return ["Timeline must be a JSON object."];
  if(!object(document.frameRate)||!Number.isFinite(Number(document.frameRate.numerator))||!Number.isFinite(Number(document.frameRate.denominator))||Number(document.frameRate.numerator)<=0||Number(document.frameRate.denominator)<=0)issues.push("Timeline frame rate must be positive.");
  if(!Array.isArray(document.tracks)||document.tracks.length>200)issues.push("Timeline must contain no more than 200 tracks.");
  if(!Array.isArray(document.markers))issues.push("Timeline markers must be an array.");
  const ids=new Set();let count=0;
  for(const track of document.tracks||[]){
    if(typeof track.id!=="string"||!track.id||ids.has(track.id))issues.push("Track IDs must be unique and non-empty.");else ids.add(track.id);
    if(!["video","audio","overlay","caption"].includes(track.kind))issues.push("Unsupported timeline track kind.");
    if(!Array.isArray(track.clips))issues.push("Every timeline track must contain a clips array.");
    let previousEnd=0;
    for(const clip of [...(track.clips||[])].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart))){
      count++;
      if(typeof clip.id!=="string"||!clip.id||ids.has(clip.id))issues.push("Clip IDs must be unique and non-empty.");else ids.add(clip.id);
      if(typeof clip.assetId!=="string"||!UUID.test(clip.assetId))issues.push("Every clip must reference a valid asset ID.");
      if(Number(clip.speed??1)!==1)issues.push("Clip speed changes are not supported.");
      const start=seconds(clip.timelineStart),duration=seconds(clip.duration),sourceStart=seconds(clip.sourceRange?.start),sourceDuration=seconds(clip.sourceRange?.duration);
      if(![start,duration,sourceStart,sourceDuration].every(Number.isFinite)||start<0||duration<=0||sourceStart<0||sourceDuration<=0)issues.push("Clip timing values must be finite and non-negative.");
      if(Number.isFinite(start)&&Number.isFinite(duration)&&start+0.000001<previousEnd)issues.push("Clips may not overlap on the same track.");
      if(Number.isFinite(start)&&Number.isFinite(duration))previousEnd=Math.max(previousEnd,start+duration);
      if(Number.isFinite(duration)&&Number.isFinite(sourceDuration)&&Math.abs(duration-sourceDuration)>Math.max(0.0001,0.5/Number(clip.sourceRange?.duration?.rate)))issues.push("Clip source and timeline durations must match.");
    }
  }
  if(count>5000)issues.push("Timeline exceeds the 5,000 clip limit.");
  for(const marker of document.markers||[]){if(!object(marker)||typeof marker.id!=="string"||!marker.id||ids.has(marker.id)||!Number.isFinite(seconds(marker.start))||seconds(marker.start)<0)issues.push("Timeline markers must have unique IDs and valid positions.");else ids.add(marker.id);}
  return issues;
}

export function createCloudTimelineRepository({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,authorize,getAsset,fetchImpl=globalThis.fetch,timeoutMs=12000,maxDocumentBytes=5*1024*1024}={}){
  if(!url||!serviceRoleKey)throw new Error("Cloud timeline repository requires server-side Supabase credentials.");
  if(typeof authorize!=="function"||typeof getAsset!=="function")throw new Error("Cloud timeline repository requires authorization and asset lookup.");
  if(typeof fetchImpl!=="function")throw new Error("Cloud timeline repository requires fetch.");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)throw new Error("Cloud timeline timeout is invalid.");
  if(!Number.isInteger(maxDocumentBytes)||maxDocumentBytes<1024||maxDocumentBytes>20*1024*1024)throw new Error("Cloud timeline document limit is invalid.");
  let base;try{const parsed=new URL(url);if(parsed.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(parsed.hostname))throw new Error();if(parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error();base=parsed.origin;}catch{throw new Error("Cloud timeline URL must be a safe absolute HTTPS URL.");}

  async function request(path,{method="GET",body=null,prefer="return=representation"}={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",prefer};
      if(body!==null)headers["content-type"]="application/json";
      const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
      const raw=await response.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{if(response.ok)throw new Error("Cloud timeline service returned invalid JSON.");}}
      if(!response.ok){const error=new Error("Cloud timeline request failed (HTTP "+response.status+").");error.code=response.status===409?"CLOUD_TIMELINE_REVISION_CONFLICT":response.status===404?"CLOUD_TIMELINE_NOT_FOUND":"CLOUD_TIMELINE_HTTP_"+response.status;error.status=response.status;throw error;}
      return data;
    }catch(error){if(error?.name==="AbortError"){const timeout=new Error("Cloud timeline request timed out.");timeout.code="CLOUD_TIMELINE_TIMEOUT";throw timeout;}throw error;}
    finally{clearTimeout(timer);}
  }
  async function allowed(ownerId,projectId,action){if(await authorize({ownerId,projectId,action})!==true){const error=new Error("Cloud timeline access denied.");error.code="CLOUD_TIMELINE_ACCESS_DENIED";throw error;}}
  function validOwner(ownerId){if(typeof ownerId!=="string"||!UUID.test(ownerId))throw new Error("Verified owner ID must be a UUID.");return ownerId;}
  function map(row){return{id:row.id,ownerId:row.owner_id,projectId:row.project_id||null,name:row.name,revision:Number(row.revision),timeline:row.timeline,otio:row.otio||null,createdAt:row.created_at,updatedAt:row.updated_at};}
  function mapVersion(row,includeSnapshot=false){
    const version={id:row.id,timelineId:row.timeline_id,ownerId:row.owner_id,projectId:row.project_id||null,revision:Number(row.revision),parentVersionId:row.parent_version_id||null,restoredFromVersionId:row.restored_from_version_id||null,name:row.name,summary:row.summary||"",contentHash:row.content_hash||null,createdBy:row.created_by,createdAt:row.created_at};
    if(includeSnapshot){
      version.document=row.timeline;version.otio=row.otio||null;
      if(version.contentHash&&timelineHash(version.document,version.otio)!==version.contentHash){const error=new Error("Timeline version snapshot failed its integrity check.");error.code="CLOUD_TIMELINE_VERSION_CORRUPT";throw error;}
    }
    return version;
  }
  async function validateAssets(ownerId,document){
    const issues=validateDocument(document);if(issues.length)return issues;
    const refs=new Map();
    for(const track of document.tracks||[])for(const clip of track.clips||[])if(clip.assetId&&!refs.has(clip.assetId))refs.set(clip.assetId,[]);
    for(const [assetId] of refs){
      try{const asset=await getAsset({ownerId,assetId});refs.set(assetId,asset);}
      catch{issues.push("Timeline references an asset that is unavailable to this account.");}
    }
    for(const track of document.tracks||[])for(const clip of track.clips||[]){
      const asset=refs.get(clip.assetId);if(!asset||Array.isArray(asset))continue;
      if(track.kind==="video"&&!asset.mediaType.startsWith("video/")&&!asset.mediaType.startsWith("image/"))issues.push("Video tracks accept only video or still-image assets.");
      if(track.kind==="audio"&&!asset.mediaType.startsWith("audio/"))issues.push("Audio tracks accept only audio assets.");
      if(track.kind==="overlay"&&!asset.mediaType.startsWith("image/"))issues.push("Overlay tracks accept only still-image assets.");
      if(track.kind==="caption"&&(!["text/plain","text/vtt"].includes(asset.mediaType)||![".srt",".vtt"].includes(String(asset.name||"").toLowerCase().slice(String(asset.name||"").lastIndexOf(".")))))issues.push("Caption tracks accept only SRT or VTT assets.");
    }
    return [...new Set(issues)];
  }
  async function checkedDocument(ownerId,document){const issues=await validateAssets(ownerId,document);if(issues.length){const error=new Error("Timeline validation failed: "+issues.slice(0,8).join(" "));error.code="CLOUD_TIMELINE_INVALID";error.issues=issues;throw error;}const size=Buffer.byteLength(JSON.stringify(document));if(size>maxDocumentBytes){const error=new Error("Timeline document exceeds the configured size limit.");error.code="CLOUD_TIMELINE_TOO_LARGE";throw error;}return document;}

  async function getTimeline({ownerId,timelineId}={}){
    ownerId=validOwner(ownerId);if(typeof timelineId!=="string"||!UUID.test(timelineId))throw new Error("Timeline ID must be a UUID.");
    const rows=await request("timelines?select=id,owner_id,project_id,name,revision,timeline,otio,created_at,updated_at&id=eq."+encodeURIComponent(timelineId)+"&archived_at=is.null&limit=1",{prefer:"return=representation"});
    const row=Array.isArray(rows)?rows[0]:null;if(!row)return null;
    await allowed(ownerId,row.project_id||null,"read");
    if(!row.project_id&&row.owner_id!==ownerId)return null;
    return map(row);
  }
  return Object.freeze({
    async create({ownerId,projectId=null,name="Untitled timeline",timeline,otio=null,versionSummary="Initial version"}={}){
      ownerId=validOwner(ownerId);if(projectId!==null&&projectId!==undefined&&projectId!==""){if(typeof projectId!=="string"||!UUID.test(projectId))throw new Error("Project ID must be a UUID.");}else projectId=null;
      if(typeof name!=="string"||name.trim().length<1||name.trim().length>160)throw new Error("Timeline name must contain 1–160 characters.");
      await allowed(ownerId,projectId,"write");await checkedDocument(ownerId,timeline);
      if(otio!==null&&!object(otio))throw new Error("OTIO document must be a JSON object.");
      const timelineId=randomUUID(),contentHash=timelineHash(timeline,otio);
      const rows=await request("rpc/ev_create_timeline_with_version",{method:"POST",body:{
        p_timeline_id:timelineId,p_owner_id:ownerId,p_actor_id:ownerId,p_project_id:projectId,
        p_name:name.trim(),p_timeline:timeline,p_otio:otio,p_summary:String(versionSummary||"Initial version").slice(0,500),p_content_hash:contentHash
      }});
      if(!Array.isArray(rows)||rows.length!==1||rows[0].owner_id!==ownerId)throw new Error("Cloud timeline creation with initial version returned an invalid record.");
      return map(rows[0]);
    },
    async list({ownerId,projectId=null,limit=50,offset=0}={}){
      ownerId=validOwner(ownerId);
      if(projectId!==null&&projectId!==undefined&&projectId!==""){if(typeof projectId!=="string"||!UUID.test(projectId))throw new Error("Project ID must be a UUID.");}else projectId=null;
      limit=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:50));offset=Math.max(0,Math.min(100000,Number.isInteger(offset)?offset:0));
      await allowed(ownerId,projectId,"read");
      const scope=projectId?"project_id=eq."+encodeURIComponent(projectId):"owner_id=eq."+encodeURIComponent(ownerId)+"&project_id=is.null";
      const rows=await request("timelines?select=id,owner_id,project_id,name,revision,timeline,otio,created_at,updated_at&"+scope+"&archived_at=is.null&order=updated_at.desc&limit="+limit+"&offset="+offset);
      return(Array.isArray(rows)?rows:[]).map(map);
    },
    get:getTimeline,
    async update({ownerId,timelineId,expectedRevision,timeline,otio,versionSummary}={}){
      ownerId=validOwner(ownerId);if(typeof timelineId!=="string"||!UUID.test(timelineId))throw new Error("Timeline ID must be a UUID.");
      if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw new Error("Expected timeline revision must be a positive integer.");
      const current=await getTimeline({ownerId,timelineId});if(!current){const error=new Error("Timeline not found.");error.code="CLOUD_TIMELINE_NOT_FOUND";throw error;}
      await allowed(ownerId,current.projectId,"write");await checkedDocument(ownerId,timeline);
      if(otio!==undefined&&otio!==null&&!object(otio))throw new Error("OTIO document must be a JSON object.");
      const nextOtio=otio===undefined?current.otio:otio;
      const rows=await request("rpc/ev_update_timeline_with_version",{method:"POST",body:{
        p_timeline_id:timelineId,p_owner_id:current.ownerId,p_actor_id:ownerId,p_expected_revision:expectedRevision,
        p_name:timeline.name||current.name,p_timeline:timeline,p_otio:nextOtio,
        p_summary:String(versionSummary||("Saved revision "+(expectedRevision+1))).slice(0,500),
        p_previous_content_hash:timelineHash(current.timeline,current.otio),p_content_hash:timelineHash(timeline,nextOtio)
      }});
      if(!Array.isArray(rows)||rows.length!==1){const error=new Error("Timeline versioned update returned an invalid result.");error.code="CLOUD_TIMELINE_VERSION_WRITE_FAILED";throw error;}
      return map(rows[0]);
    },
    async listVersions({ownerId,timelineId,limit=100,offset=0}={}){
      ownerId=validOwner(ownerId);if(typeof timelineId!=="string"||!UUID.test(timelineId))throw new Error("Timeline ID must be a UUID.");
      limit=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:100));offset=Math.max(0,Math.min(100000,Number.isInteger(offset)?offset:0));
      const current=await getTimeline({ownerId,timelineId});if(!current){const error=new Error("Timeline not found.");error.code="CLOUD_TIMELINE_NOT_FOUND";throw error;}
      await allowed(ownerId,current.projectId,"read");
      const rows=await request("timeline_versions?select=id,timeline_id,owner_id,project_id,revision,parent_version_id,restored_from_version_id,name,summary,content_hash,created_by,created_at&timeline_id=eq."+encodeURIComponent(timelineId)+"&owner_id=eq."+encodeURIComponent(current.ownerId)+"&order=revision.desc&limit="+limit+"&offset="+offset);
      return(Array.isArray(rows)?rows:[]).map(row=>mapVersion(row));
    },
    async getVersion({ownerId,timelineId,versionId}={}){
      ownerId=validOwner(ownerId);if(typeof timelineId!=="string"||!UUID.test(timelineId)||typeof versionId!=="string"||!UUID.test(versionId))throw new Error("Timeline and version IDs must be UUIDs.");
      const current=await getTimeline({ownerId,timelineId});if(!current){const error=new Error("Timeline not found.");error.code="CLOUD_TIMELINE_NOT_FOUND";throw error;}
      await allowed(ownerId,current.projectId,"read");
      const rows=await request("timeline_versions?select=*&id=eq."+encodeURIComponent(versionId)+"&timeline_id=eq."+encodeURIComponent(timelineId)+"&owner_id=eq."+encodeURIComponent(current.ownerId)+"&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;if(!row){const error=new Error("Timeline version not found.");error.code="CLOUD_TIMELINE_VERSION_NOT_FOUND";throw error;}
      return mapVersion(row,true);
    },
    async restore({ownerId,timelineId,expectedRevision,sourceVersionId,summary}={}){
      ownerId=validOwner(ownerId);if(typeof timelineId!=="string"||!UUID.test(timelineId)||typeof sourceVersionId!=="string"||!UUID.test(sourceVersionId))throw new Error("Timeline and source version IDs must be UUIDs.");
      if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw new Error("Expected timeline revision must be a positive integer.");
      const current=await getTimeline({ownerId,timelineId});if(!current){const error=new Error("Timeline not found.");error.code="CLOUD_TIMELINE_NOT_FOUND";throw error;}
      await allowed(ownerId,current.projectId,"write");
      const sourceRows=await request("timeline_versions?select=*&id=eq."+encodeURIComponent(sourceVersionId)+"&timeline_id=eq."+encodeURIComponent(timelineId)+"&owner_id=eq."+encodeURIComponent(current.ownerId)+"&limit=1");
      const sourceRow=Array.isArray(sourceRows)?sourceRows[0]:null;
      if(!sourceRow){const error=new Error("Timeline version not found.");error.code="CLOUD_TIMELINE_VERSION_NOT_FOUND";throw error;}
      const source=mapVersion(sourceRow,true);
      await checkedDocument(ownerId,source.document);
      const contentHash=timelineHash(source.document,source.otio);
      const rows=await request("rpc/ev_restore_timeline_version",{method:"POST",body:{
        p_timeline_id:timelineId,p_owner_id:current.ownerId,p_actor_id:ownerId,p_expected_revision:expectedRevision,
        p_source_version_id:sourceVersionId,p_summary:String(summary||("Restored from revision "+source.revision)).slice(0,500),
        p_previous_content_hash:timelineHash(current.timeline,current.otio),p_content_hash:contentHash
      }});
      if(!Array.isArray(rows)||rows.length!==1){const error=new Error("Timeline version restore returned an invalid result.");error.code="CLOUD_TIMELINE_VERSION_RESTORE_FAILED";throw error;}
      return map(rows[0]);
    },
    async archive({ownerId,timelineId,expectedRevision}={}){
      ownerId=validOwner(ownerId);
      if(typeof timelineId!=="string"||!UUID.test(timelineId))throw new Error("Timeline ID must be a UUID.");
      if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw new Error("Expected timeline revision must be a positive integer.");
      const current=await getTimeline({ownerId,timelineId});if(!current){const error=new Error("Timeline not found.");error.code="CLOUD_TIMELINE_NOT_FOUND";throw error;}
      await allowed(ownerId,current.projectId,"write");
      const rows=await request("timelines?id=eq."+encodeURIComponent(timelineId)+"&revision=eq."+expectedRevision+"&archived_at=is.null",{method:"PATCH",body:{archived_at:new Date().toISOString(),revision:expectedRevision+1,updated_at:new Date().toISOString()}});
      if(!Array.isArray(rows)||rows.length!==1){const error=new Error("Timeline changed before it could be archived.");error.code="CLOUD_TIMELINE_REVISION_CONFLICT";throw error;}
      return{id:timelineId,archived:true,revision:Number(rows[0].revision)};
    }
  });
}
