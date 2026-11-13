import { randomUUID } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const seconds=value=>Number(value?.value)/Number(value?.rate);

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
    const orderedClips=[...(track.clips||[])].sort((a,b)=>seconds(a.timelineStart)-seconds(b.timelineStart));
    const enabledClips=orderedClips.filter(clip=>clip.enabled!==false);
    let previousEnd=0;
    for(const clip of orderedClips){
      count++;
      if(typeof clip.id!=="string"||!clip.id||ids.has(clip.id))issues.push("Clip IDs must be unique and non-empty.");else ids.add(clip.id);
      if(typeof clip.assetId!=="string"||!UUID.test(clip.assetId))issues.push("Every clip must reference a valid asset ID.");
      if(Number(clip.speed??1)!==1)issues.push("Clip speed changes are not supported.");
      const start=seconds(clip.timelineStart),duration=seconds(clip.duration),sourceStart=seconds(clip.sourceRange?.start),sourceDuration=seconds(clip.sourceRange?.duration);
      if(![start,duration,sourceStart,sourceDuration].every(Number.isFinite)||start<0||duration<=0||sourceStart<0||sourceDuration<=0)issues.push("Clip timing values must be finite and non-negative.");
      if(Number.isFinite(start)&&Number.isFinite(duration)&&start+0.000001<previousEnd)issues.push("Clips may not overlap on the same track.");
      if(Number.isFinite(start)&&Number.isFinite(duration))previousEnd=Math.max(previousEnd,start+duration);
      if(Number.isFinite(duration)&&Number.isFinite(sourceDuration)&&Math.abs(duration-sourceDuration)>Math.max(0.0001,0.5/Number(clip.sourceRange?.duration?.rate)))issues.push("Clip source and timeline durations must match.");
      if(clip.enabled!==false&&clip.transitionToNext!==undefined){
        const transition=clip.transitionToNext,index=enabledClips.findIndex(item=>item.id===clip.id),next=enabledClips[index+1];
        const fadeFrames=Number(transition?.fadeFrames),fps=Number(document.frameRate.numerator)/Number(document.frameRate.denominator),durationFrames=Math.round(duration*fps);
        if(track.kind!=="video"||transition?.type!=="dip-to-black"||!Number.isSafeInteger(fadeFrames)||fadeFrames<1||fadeFrames>durationFrames)issues.push("Video dip-to-black transitions require a positive integer fade length no longer than the outgoing clip.");
        else if(!next||Math.abs(seconds(next.timelineStart)-(start+duration))>0.5/fps)issues.push("A dip-to-black transition requires the next enabled video clip to begin immediately after this clip.");
        else if(fadeFrames>Math.round(seconds(next.duration)*fps))issues.push("The transition fade cannot be longer than the incoming clip.");
      }
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
      if(!response.ok){const error=new Error("Cloud timeline request failed (HTTP "+response.status+").");error.code="CLOUD_TIMELINE_HTTP_"+response.status;error.status=response.status;throw error;}
      return data;
    }catch(error){if(error?.name==="AbortError"){const timeout=new Error("Cloud timeline request timed out.");timeout.code="CLOUD_TIMELINE_TIMEOUT";throw timeout;}throw error;}
    finally{clearTimeout(timer);}
  }
  async function allowed(ownerId,projectId,action){if(await authorize({ownerId,projectId,action})!==true){const error=new Error("Cloud timeline access denied.");error.code="CLOUD_TIMELINE_ACCESS_DENIED";throw error;}}
  function validOwner(ownerId){if(typeof ownerId!=="string"||!UUID.test(ownerId))throw new Error("Verified owner ID must be a UUID.");return ownerId;}
  function map(row){return{id:row.id,ownerId:row.owner_id,projectId:row.project_id||null,name:row.name,revision:Number(row.revision),timeline:row.timeline,otio:row.otio||null,createdAt:row.created_at,updatedAt:row.updated_at};}
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
  async function listTimelineRevisions({ownerId,timelineId,limit=50,offset=0}={}){
    const current=await getTimeline({ownerId,timelineId});
    if(!current)return null;
    limit=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:50));
    offset=Math.max(0,Math.min(100000,Number.isInteger(offset)?offset:0));
    const rows=await request("timeline_revisions?select=timeline_id,revision,name,created_at&timeline_id=eq."+encodeURIComponent(timelineId)+"&order=revision.desc&limit="+limit+"&offset="+offset);
    return(Array.isArray(rows)?rows:[]).map(row=>({timelineId:row.timeline_id,revision:Number(row.revision),name:row.name,createdAt:row.created_at}));
  }
  async function getTimelineRevision({ownerId,timelineId,revision}={}){
    const current=await getTimeline({ownerId,timelineId});
    if(!current)return null;
    if(!Number.isInteger(revision)||revision<1)throw new Error("Timeline revision must be a positive integer.");
    const rows=await request("timeline_revisions?select=timeline_id,revision,name,timeline,otio,created_at&timeline_id=eq."+encodeURIComponent(timelineId)+"&revision=eq."+revision+"&limit=1");
    const row=Array.isArray(rows)?rows[0]:null;
    return row?{timelineId:row.timeline_id,revision:Number(row.revision),name:row.name,timeline:row.timeline,otio:row.otio||null,createdAt:row.created_at}:null;
  }
  return Object.freeze({
    async create({ownerId,projectId=null,name="Untitled timeline",timeline,otio=null}={}){
      ownerId=validOwner(ownerId);if(projectId!==null&&projectId!==undefined&&projectId!==""){if(typeof projectId!=="string"||!UUID.test(projectId))throw new Error("Project ID must be a UUID.");}else projectId=null;
      if(typeof name!=="string"||name.trim().length<1||name.trim().length>160)throw new Error("Timeline name must contain 1–160 characters.");
      await allowed(ownerId,projectId,"write");await checkedDocument(ownerId,timeline);
      if(otio!==null&&!object(otio))throw new Error("OTIO document must be a JSON object.");
      const rows=await request("timelines?select=id,owner_id,project_id,name,revision,timeline,otio,created_at,updated_at",{method:"POST",body:{id:randomUUID(),owner_id:ownerId,project_id:projectId,name:name.trim(),revision:1,timeline,otio}});
      if(!Array.isArray(rows)||rows.length!==1||rows[0].owner_id!==ownerId)throw new Error("Cloud timeline creation returned an invalid record.");
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
    listRevisions:listTimelineRevisions,
    getRevision:getTimelineRevision,
    async update({ownerId,timelineId,expectedRevision,timeline,otio}={}){
      ownerId=validOwner(ownerId);if(typeof timelineId!=="string"||!UUID.test(timelineId))throw new Error("Timeline ID must be a UUID.");
      if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw new Error("Expected timeline revision must be a positive integer.");
      const current=await getTimeline({ownerId,timelineId});if(!current){const error=new Error("Timeline not found.");error.code="CLOUD_TIMELINE_NOT_FOUND";throw error;}
      await allowed(ownerId,current.projectId,"write");await checkedDocument(ownerId,timeline);
      if(otio!==undefined&&otio!==null&&!object(otio))throw new Error("OTIO document must be a JSON object.");
      const body={timeline,revision:expectedRevision+1,updated_at:new Date().toISOString()};
      if(otio!==undefined)body.otio=otio;
      const rows=await request("timelines?id=eq."+encodeURIComponent(timelineId)+"&revision=eq."+expectedRevision+"&archived_at=is.null",{method:"PATCH",body});
      if(!Array.isArray(rows)||rows.length!==1){const error=new Error("Timeline changed since it was loaded. Reload before saving.");error.code="CLOUD_TIMELINE_REVISION_CONFLICT";throw error;}
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
