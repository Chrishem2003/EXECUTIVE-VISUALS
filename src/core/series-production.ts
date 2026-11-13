import type { CreativeStoryboard } from "./creative-intent";
export type SeriesFormat="documentary"|"docuseries"|"education"|"fiction"|"interview"|"brand"|"children"|"shorts";
export type SeriesDefaults={episodeRuntimeSeconds:number;shotLengthSeconds:number;aspectRatio:string;frameRate:number;resolution:string;visualStyle:string;language:string;voiceMode:string;captions:string;music:string;cameraLanguage:string;shotComposition:string;pacing:string;colorGrade:string};
export type EpisodeShot={id:string;durationSeconds:number;prompt:string;status:"planned";camera?:string;framing?:string;movement?:string;lens?:string;negativePrompt?:string;storyBibleEntryIds?:string[]};
export type EpisodeScene={id:string;title:string;purpose:string;durationSeconds:number;shots:EpisodeShot[];storyBibleEntryIds?:string[]};
export type EpisodeDirectionOverrides=Partial<Pick<SeriesDefaults,"episodeRuntimeSeconds"|"aspectRatio"|"frameRate"|"resolution"|"visualStyle"|"cameraLanguage"|"shotComposition"|"pacing"|"colorGrade"|"language"|"voiceMode"|"captions"|"music">>;
export type StoryBibleKind="character"|"location"|"prop"|"wardrobe"|"voice"|"brand-rule";
export type StoryBibleEntry={id:string;kind:StoryBibleKind;name:string;description:string;visualRules:string;referenceAssetIds:string[];tags:string[];createdAt:string;updatedAt:string};
export type SeriesStoryBible={version:1;entries:StoryBibleEntry[];globalRules:string;updatedAt:string};
export type SeriesEpisode={id:string;number:number;title:string;runtimeSeconds:number;status:"planned";logline?:string;recap?:string;nextHook?:string;overrides?:EpisodeDirectionOverrides;scenes:EpisodeScene[]};
export type SeriesSeason={id:string;number:number;title:string;episodes:SeriesEpisode[]};
export type SeriesProductionPlan={id:string;schemaVersion:1;title:string;premise:string;format:SeriesFormat;genre:string;continuityNotes:string;defaults:SeriesDefaults;seasons:SeriesSeason[];storyBible?:SeriesStoryBible;seasonArcs?:Record<string,string>;createdAt:string;updatedAt:string};
export type SeriesProductionInput={title:string;premise:string;format:string;genre?:string;seasonCount:number;episodesPerSeason:number;episodeRuntimeSeconds:number;shotLengthSeconds:number;aspectRatio:string;frameRate:number;resolution:string;visualStyle:string;language:string;voiceMode:string;captions:string;music:string;cameraLanguage:string;shotComposition:string;pacing:string;colorGrade:string;continuityNotes?:string};
export const MAX_EPISODE_SECONDS=1800,MAX_GENERATED_CLIP_SECONDS=30;
export const EPISODE_RUNTIME_CHOICES=Object.freeze([15,30,60,90,120,180,240,300,600,900,1200,1800]);
const RATIOS=new Set(["16:9","9:16","1:1","4:3","3:4","21:9"]),FORMATS=new Set(["documentary","docuseries","education","fiction","interview","brand","children","shorts"]);
const text=(v:unknown,n:number,l:string)=>{if(typeof v!=="string"||!v.trim()||v.trim().length>n)throw new Error(l+" must contain 1–"+n+" characters.");return v.trim();};
const integer=(v:number,min:number,max:number,l:string)=>{if(!Number.isInteger(v)||v<min||v>max)throw new Error(l+" must be a whole number from "+min+" to "+max+".");return v;};
const uid=()=>globalThis.crypto?.randomUUID?.()||"id-"+Math.random().toString(36).slice(2)+Date.now().toString(36);
const BEATS=[{title:"Opening hook",purpose:"Create an immediate visual or narrative reason to keep watching.",weight:12},{title:"Context and promise",purpose:"Establish the subject, stakes and episode question.",weight:18},{title:"Development",purpose:"Build the central story through evidence, action or escalating beats.",weight:32},{title:"Reveal and payoff",purpose:"Deliver the strongest discovery, transformation or emotional payoff.",weight:25},{title:"Closing and next episode",purpose:"Resolve the episode and create a natural reason to return.",weight:13}];
function allocate(total:number,weights:number[]){const sum=weights.reduce((a,b)=>a+b,0),raw=weights.map((w,i)=>({i,value:total*w/sum})),out=raw.map(x=>Math.floor(x.value));let rem=total-out.reduce((a,b)=>a+b,0);raw.sort((a,b)=>(b.value-Math.floor(b.value))-(a.value-Math.floor(a.value)));for(let i=0;i<rem;i++)out[raw[i].i]++;return out;}
function makeEpisode(season:number,number:number,runtime:number,shotLength:number):SeriesEpisode{
 const scenes=BEATS.map((beat,index)=>{const durationSeconds=allocate(runtime,BEATS.map(x=>x.weight))[index],count=Math.ceil(durationSeconds/shotLength),durations=allocate(durationSeconds,Array(count).fill(1));return{id:"s"+season+"-e"+number+"-scene"+(index+1),title:beat.title,purpose:beat.purpose,durationSeconds,shots:durations.map((durationSeconds,shotIndex)=>({id:"s"+season+"-e"+number+"-scene"+(index+1)+"-shot"+(shotIndex+1),durationSeconds,prompt:"Add the specific action, subject, framing, camera movement and continuity instructions for this shot.",status:"planned" as const}))};});
 return{id:"s"+season+"-e"+number,number,title:"Episode "+String(number).padStart(2,"0")+" · Working title",runtimeSeconds:runtime,status:"planned",scenes};
}
export function buildSeriesProductionPlan(input:SeriesProductionInput):SeriesProductionPlan{
 const title=text(input.title,120,"Series title"),premise=text(input.premise,3000,"Series premise");
 if(!FORMATS.has(input.format))throw new Error("Choose a supported series format.");
 const seasons=integer(input.seasonCount,1,5,"Season count"),episodes=integer(input.episodesPerSeason,1,20,"Episodes per season"),runtime=integer(input.episodeRuntimeSeconds,15,MAX_EPISODE_SECONDS,"Episode runtime"),shot=integer(input.shotLengthSeconds,1,MAX_GENERATED_CLIP_SECONDS,"Shot length"),frameRate=integer(input.frameRate,1,120,"Frame rate");
 if(!EPISODE_RUNTIME_CHOICES.includes(runtime))throw new Error("Choose a supported episode runtime preset.");if(!RATIOS.has(input.aspectRatio))throw new Error("Unsupported aspect ratio.");
 const defaults:SeriesDefaults={episodeRuntimeSeconds:runtime,shotLengthSeconds:shot,aspectRatio:input.aspectRatio,frameRate,resolution:text(input.resolution,20,"Resolution"),visualStyle:text(input.visualStyle,80,"Visual style"),language:text(input.language,40,"Language"),voiceMode:text(input.voiceMode,80,"Voice approach"),captions:text(input.captions,80,"Caption mode"),music:text(input.music,100,"Music direction"),cameraLanguage:text(input.cameraLanguage,100,"Camera language"),shotComposition:text(input.shotComposition,100,"Shot composition"),pacing:text(input.pacing,100,"Pacing"),colorGrade:text(input.colorGrade,100,"Color grade")},now=new Date().toISOString();
 const result:SeriesProductionPlan={id:uid(),schemaVersion:1,title,premise,format:input.format as SeriesFormat,genre:String(input.genre||"").trim().slice(0,100),continuityNotes:String(input.continuityNotes||"").trim().slice(0,2000),defaults,seasons:Array.from({length:seasons},(_,s)=>({id:"season-"+(s+1)+"-"+uid(),number:s+1,title:"Season "+(s+1),episodes:Array.from({length:episodes},(_,e)=>makeEpisode(s+1,e+1,runtime,shot))})),createdAt:now,updatedAt:now};
 const check=validateSeriesProductionPlan(result);if(!check.valid)throw new Error(check.issues.join(" "));return result;
}
export function validateSeriesProductionPlan(plan:SeriesProductionPlan){
 const issues:string[]=[],ids=new Set<string>(),bibleEntries=Array.isArray(plan?.storyBible?.entries)?plan.storyBible.entries:[],bibleIds=new Set<string>(),unique=(id:string,label:string)=>{if(typeof id!=="string"||!id.trim()||ids.has(id))issues.push(label+" IDs must be unique and non-empty.");else ids.add(id);};
 if(!plan||plan.schemaVersion!==1)issues.push("Unsupported series plan schema.");
 if(bibleEntries.length>500)issues.push("A series story bible may contain at most 500 records.");
 for(const entry of bibleEntries){if(typeof entry.id!=="string"||!entry.id.trim()||bibleIds.has(entry.id))issues.push("Story bible IDs must be unique and non-empty.");else bibleIds.add(entry.id);}
 if(!Array.isArray(plan.seasons)||plan.seasons.length<1||plan.seasons.length>5)issues.push("A series must contain 1–5 seasons.");
 for(const season of plan.seasons||[]){unique(season.id,"Season");if(!Array.isArray(season.episodes)||season.episodes.length>20)issues.push("Each season may contain at most 20 episodes.");
 for(const episode of season.episodes||[]){unique(episode.id,"Episode");if(!Number.isInteger(episode.runtimeSeconds)||episode.runtimeSeconds<1||episode.runtimeSeconds>MAX_EPISODE_SECONDS)issues.push("Episode runtime must not exceed 1800 seconds (30 minutes).");if(!Array.isArray(episode.scenes)||!episode.scenes.length)issues.push("Every episode requires a scene.");let total=0;
 for(const scene of episode.scenes||[]){unique(scene.id,"Scene");if(!Array.isArray(scene.shots)||!scene.shots.length)issues.push("Every scene requires a shot.");if(scene.storyBibleEntryIds!==undefined&&(!Array.isArray(scene.storyBibleEntryIds)||scene.storyBibleEntryIds.some(id=>typeof id!=="string"||!id.trim()||!bibleIds.has(id))||new Set(scene.storyBibleEntryIds).size!==scene.storyBibleEntryIds.length))issues.push("Scene story bible bindings must reference unique, existing records.");let sceneTotal=0;
 for(const shot of scene.shots||[]){unique(shot.id,"Shot");for(const [field,limit] of ([["prompt",2000],["camera",240],["framing",160],["movement",240],["lens",120],["negativePrompt",1200]] as [string,number][])){const value=shot[field as keyof EpisodeShot];if(value!==undefined&&(typeof value!=="string"||value.length>limit))issues.push("Shot "+field+" exceeds its allowed text bounds.");}if(shot.storyBibleEntryIds!==undefined&&(!Array.isArray(shot.storyBibleEntryIds)||shot.storyBibleEntryIds.some(id=>typeof id!=="string"||!id.trim()||!bibleIds.has(id))||new Set(shot.storyBibleEntryIds).size!==shot.storyBibleEntryIds.length))issues.push("Shot story bible bindings must reference unique, existing records.");if(!Number.isInteger(shot.durationSeconds)||shot.durationSeconds<1||shot.durationSeconds>MAX_GENERATED_CLIP_SECONDS)issues.push("Each clip must be 1–30 seconds.");sceneTotal+=Number(shot.durationSeconds)||0;}
 if(sceneTotal!==scene.durationSeconds)issues.push("Shot durations must add up to the scene runtime.");total+=sceneTotal;}
 if(total!==episode.runtimeSeconds)issues.push("Scene and shot durations must add up to episode runtime.");}}
 return{valid:issues.length===0,issues};
}


export interface EpisodeTimelineMarker {id:string;name:string;start:{value:number;rate:number};duration:{value:number;rate:number};color:string;note:string}
export interface EpisodeTimelineDocument {id:string;projectId:string;name:string;revision:number;frameRate:{numerator:number;denominator:number};width:number;height:number;pixelAspectRatio:number;tracks:Array<{id:string;name:string;kind:"video"|"audio"|"caption"|"overlay";enabled:boolean;locked:boolean;clips:never[]}>;markers:EpisodeTimelineMarker[];createdAt:string;updatedAt:string}
const RATIO_SIZE:Record<string,{width:number;height:number}>={"16:9":{width:1920,height:1080},"9:16":{width:1080,height:1920},"1:1":{width:1080,height:1080},"4:3":{width:1440,height:1080},"3:4":{width:1080,height:1440},"21:9":{width:2560,height:1080}};
/** Build an editable, asset-free editorial sequence from a planned episode.
 * Scene and shot markers preserve the story structure; no fake media clips are inserted.
 */
export function buildEpisodeTimelineDocument(series:SeriesProductionPlan,episode:SeriesEpisode,projectId:string):EpisodeTimelineDocument{
 if(!projectId.trim())throw new Error("A cloud project is required to create an episode timeline.");
 if(!validateSeriesProductionPlan(series).valid)throw new Error("Cannot create a timeline from an invalid series plan.");
 if(!series.seasons.some(season=>season.episodes.some(item=>item.id===episode.id)))throw new Error("Episode does not belong to this series.");
 const direction=resolveEpisodeDirection(series,episode),size=RATIO_SIZE[direction.aspectRatio]||RATIO_SIZE["16:9"],fps=direction.frameRate,now=new Date().toISOString(),markers:EpisodeTimelineMarker[]=[];
 let cursor=0;
 for(const scene of episode.scenes){
  markers.push({id:scene.id,name:scene.title,start:{value:cursor,rate:1},duration:{value:scene.durationSeconds,rate:1},color:"#6c8cff",note:scene.purpose});
  let shotCursor=cursor;
  for(const shot of scene.shots){markers.push({id:shot.id,name:scene.title+" · "+shot.id.split("-").slice(-1)[0],start:{value:shotCursor,rate:1},duration:{value:shot.durationSeconds,rate:1},color:"#29a38b",note:shot.prompt});shotCursor+=shot.durationSeconds;}
  cursor+=scene.durationSeconds;
 }
 if(cursor!==direction.episodeRuntimeSeconds)throw new Error("Episode timeline markers do not match the effective episode runtime.");
 const tracks:EpisodeTimelineDocument["tracks"]=[
  {id:episode.id+"-video",name:"Picture · planned shots",kind:"video",enabled:true,locked:false,clips:[]},
  {id:episode.id+"-audio",name:"Dialogue / music / effects",kind:"audio",enabled:true,locked:false,clips:[]},
  {id:episode.id+"-captions",name:"Captions & subtitles",kind:"caption",enabled:true,locked:false,clips:[]},
  {id:episode.id+"-graphics",name:"Titles / overlays",kind:"overlay",enabled:true,locked:false,clips:[]}
 ];
 return{id:"episode-"+episode.id,projectId,name:series.title+" · "+episode.title,revision:1,frameRate:{numerator:fps,denominator:1},width:size.width,height:size.height,pixelAspectRatio:1,tracks,markers,createdAt:now,updatedAt:now};
}

/** Match completed provider outputs to the exact approved storyboard shot order. */
export type GeneratedStoryboardAsset = {
 id:string;
 projectId?:string|null;
 mediaType:string;
 metadata?:Record<string,unknown>;
};
export function matchGeneratedStoryboardAssets<T extends GeneratedStoryboardAsset>(
 shots:readonly EpisodeShot[],
 assets:readonly T[],
 approvalId:string,
 projectId:string
):Array<{shot:EpisodeShot;asset:T;shotIndex:number}>{
 if(!approvalId.trim()||!projectId.trim())throw new Error("A cloud project and approved production are required to match generated shots.");
 if(!shots.length)throw new Error("The storyboard contains no shots to place on the timeline.");
 const byIndex=new Map<number,T>();
 for(const asset of assets){
  const metadata=asset.metadata||{};
  if(metadata.operation!=="video.generate"||metadata.approvalId!==approvalId)continue;
  if(asset.projectId!==projectId)throw new Error("A generated storyboard asset belongs to a different cloud project.");
  const shotIndex=Number(metadata.shotIndex);
  if(!Number.isInteger(shotIndex)||shotIndex<0||shotIndex>=shots.length)throw new Error("A generated storyboard asset has an invalid shot index.");
  if(!String(asset.mediaType||"").startsWith("video/"))throw new Error("A generated storyboard output is not a video asset.");
  if(byIndex.has(shotIndex))throw new Error("More than one generated asset matches storyboard shot "+(shotIndex+1)+".");
  byIndex.set(shotIndex,asset);
 }
 const missing=shots.map((_,index)=>index).filter(index=>!byIndex.has(index));
 if(missing.length)throw new Error("Generated video outputs are incomplete. Missing storyboard shot(s): "+missing.map(index=>index+1).join(", ")+".");
 return shots.map((shot,shotIndex)=>({shot,asset:byIndex.get(shotIndex)!,shotIndex}));
}

const BIBLE_KINDS=new Set<StoryBibleKind>(["character","location","prop","wardrobe","voice","brand-rule"]);
const OVERRIDE_TEXT_LIMITS:Partial<Record<keyof SeriesDefaults,number>>={aspectRatio:8,resolution:20,visualStyle:80,cameraLanguage:100,shotComposition:100,pacing:100,colorGrade:100,language:40,voiceMode:80,captions:80,music:100};
/** Merge episode-specific direction over series defaults without mutating either record. */
export function resolveEpisodeDirection(series:SeriesProductionPlan,episode:SeriesEpisode):SeriesDefaults{
 if(!series.seasons.some(season=>season.episodes.some(item=>item.id===episode.id)))throw new Error("Episode does not belong to this series.");
 const merged={...series.defaults,...(episode.overrides||{})};
 if(!Number.isInteger(merged.episodeRuntimeSeconds)||merged.episodeRuntimeSeconds<15||merged.episodeRuntimeSeconds>MAX_EPISODE_SECONDS)throw new Error("Episode runtime override must be 15–1800 seconds.");
 if(!EPISODE_RUNTIME_CHOICES.includes(merged.episodeRuntimeSeconds))throw new Error("Episode runtime override must use a supported runtime preset.");
 if(!RATIOS.has(merged.aspectRatio))throw new Error("Episode aspect ratio override is unsupported.");
 if(!Number.isInteger(merged.frameRate)||merged.frameRate<1||merged.frameRate>120)throw new Error("Episode frame-rate override is invalid.");
 return merged;
}
/** Add or replace a story-world record. Reference assets are IDs, never embedded binaries. */
export function upsertStoryBibleEntry(series:SeriesProductionPlan,input:Omit<StoryBibleEntry,"id"|"createdAt"|"updatedAt"> & {id?:string}):SeriesProductionPlan{
 if(!BIBLE_KINDS.has(input.kind))throw new Error("Unsupported story bible record type.");
 const name=text(input.name,120,"Story bible name"),description=text(input.description,2000,"Story bible description");
 const visualRules=String(input.visualRules||"").trim().slice(0,2000),referenceAssetIds=[...new Set((input.referenceAssetIds||[]).filter(id=>typeof id==="string"&&/^[0-9a-f-]{36}$/i.test(id)))].slice(0,20),tags=[...new Set((input.tags||[]).map(tag=>String(tag).trim().slice(0,40)).filter(Boolean))].slice(0,20);
 const previous=series.storyBible?.entries.find(entry=>entry.id===input.id),now=new Date().toISOString(),entry:StoryBibleEntry={id:previous?.id||globalThis.crypto?.randomUUID?.()||"bible-"+Date.now(),kind:input.kind,name,description,visualRules,referenceAssetIds,tags,createdAt:previous?.createdAt||now,updatedAt:now};
 const entries=[...(series.storyBible?.entries||[]).filter(item=>item.id!==entry.id),entry];
 if(entries.length>500)throw new Error("A series story bible may contain at most 500 records.");
 return{...series,storyBible:{version:1,entries,globalRules:series.storyBible?.globalRules||"",updatedAt:now},updatedAt:now};
}
export function setEpisodeDirectionOverrides(series:SeriesProductionPlan,episodeId:string,overrides:EpisodeDirectionOverrides):SeriesProductionPlan{
 let found=false;
 const allowed=new Set<keyof SeriesDefaults>(["episodeRuntimeSeconds","aspectRatio","frameRate","resolution","visualStyle","cameraLanguage","shotComposition","pacing","colorGrade","language","voiceMode","captions","music"]);
 const clean:EpisodeDirectionOverrides={};
 for(const [rawKey,value] of Object.entries(overrides)){const key=rawKey as keyof SeriesDefaults;if(!allowed.has(key))throw new Error("Unsupported episode override.");if(key==="episodeRuntimeSeconds"){if(!Number.isInteger(value)||Number(value)<15||Number(value)>MAX_EPISODE_SECONDS||!EPISODE_RUNTIME_CHOICES.includes(Number(value)))throw new Error("Episode runtime override must be a supported value up to 30 minutes.");(clean as Record<string,unknown>)[key]=value;}else if(key==="frameRate"){if(!Number.isInteger(value)||Number(value)<1||Number(value)>120)throw new Error("Frame-rate override must be 1–120.");(clean as Record<string,unknown>)[key]=value;}else{const limit=OVERRIDE_TEXT_LIMITS[key]||100;if(typeof value!=="string"||!value.trim()||value.length>limit)throw new Error("Invalid "+key+" override.");(clean as Record<string,unknown>)[key]=value.trim();}}
 const effectiveRuntime=clean.episodeRuntimeSeconds??series.defaults.episodeRuntimeSeconds;const next={...series,seasons:series.seasons.map(season=>({...season,episodes:season.episodes.map(episode=>{if(episode.id!==episodeId)return episode;found=true;let scenes=episode.scenes;if(effectiveRuntime!==episode.runtimeSeconds){const weights=episode.scenes.map(scene=>Math.max(1,scene.durationSeconds)),durations=allocate(effectiveRuntime,weights);scenes=episode.scenes.map((scene,index)=>{const durationSeconds=durations[index],targetCount=Math.max(Math.ceil(durationSeconds/MAX_GENERATED_CLIP_SECONDS),Math.min(scene.shots.length,durationSeconds)),sourceShots=scene.shots.slice(0,targetCount),shotDurations=allocate(durationSeconds,Array(targetCount).fill(1)),shots=shotDurations.map((shotDuration,shotIndex)=>{const source=sourceShots[shotIndex]||scene.shots[Math.max(0,scene.shots.length-1)]||{prompt:"Add shot direction.",status:"planned" as const};return{...source,id:sourceShots[shotIndex]?.id||scene.id+"-override-shot-"+(shotIndex+1),durationSeconds:shotDuration};});return{...scene,durationSeconds,shots};});}return{...episode,runtimeSeconds:effectiveRuntime,scenes,overrides:Object.keys(clean).length?clean:undefined};})})),updatedAt:new Date().toISOString()};
 if(!found)throw new Error("Episode does not belong to this series.");
 const episode=next.seasons.flatMap(season=>season.episodes).find(item=>item.id===episodeId)!;resolveEpisodeDirection(next,episode);
 return next;
}


/** Bind story-world records to one scene or one specific shot. */
export function setEpisodeStoryBibleBindings(series:SeriesProductionPlan,episodeId:string,sceneId:string,shotId:string|null,entryIds:string[]):SeriesProductionPlan{
 const entries=series.storyBible?.entries||[],known=new Set(entries.map(entry=>entry.id));
 const clean=[...new Set(entryIds)];
 if(clean.length>50||clean.some(id=>typeof id!=="string"||!known.has(id)))throw new Error("Bindings must reference up to 50 existing story bible records.");
 let episodeFound=false,sceneFound=false,shotFound=false;
 const seasons=series.seasons.map(season=>({...season,episodes:season.episodes.map(episode=>{
  if(episode.id!==episodeId)return episode;episodeFound=true;
  return{...episode,scenes:episode.scenes.map(scene=>{
   if(scene.id!==sceneId)return scene;sceneFound=true;
   if(shotId===null)return{...scene,storyBibleEntryIds:clean};
   return{...scene,shots:scene.shots.map(shot=>{if(shot.id!==shotId)return shot;shotFound=true;return{...shot,storyBibleEntryIds:clean};})};
  })};
 })}));
 if(!episodeFound||!sceneFound||(shotId!==null&&!shotFound))throw new Error("The selected episode, scene or shot does not belong to this series.");
 return{...series,seasons,updatedAt:new Date().toISOString()};
}

export type EpisodeShotDirectionPatch=Partial<Pick<EpisodeShot,"prompt"|"camera"|"framing"|"movement"|"lens"|"negativePrompt">>;
/** Update shot-specific creative direction without changing episode timing or sibling shots. */
export function updateEpisodeShotDirection(series:SeriesProductionPlan,episodeId:string,sceneId:string,shotId:string,patch:EpisodeShotDirectionPatch):SeriesProductionPlan{
 const limits:{[K in keyof EpisodeShotDirectionPatch]:number}={prompt:2000,camera:240,framing:160,movement:240,lens:120,negativePrompt:1200};
 for(const [key,value] of Object.entries(patch)){const max=limits[key as keyof EpisodeShotDirectionPatch]??0;if(typeof value!=="string"||value.length>max)throw new Error("Shot "+key+" must be text within "+max+" characters.");}
 let episodeFound=false,sceneFound=false,shotFound=false;
 const seasons=series.seasons.map(season=>({...season,episodes:season.episodes.map(episode=>{
  if(episode.id!==episodeId)return episode;episodeFound=true;
  return{...episode,scenes:episode.scenes.map(scene=>{
   if(scene.id!==sceneId)return scene;sceneFound=true;
   return{...scene,shots:scene.shots.map(shot=>{if(shot.id!==shotId)return shot;shotFound=true;return{...shot,...patch};})};
  })};
 })}));
 if(!episodeFound||!sceneFound||!shotFound)throw new Error("The selected shot does not belong to this series episode.");
 return{...series,seasons,updatedAt:new Date().toISOString()};
}

export type EpisodeShotPackageItem={shotId:string;sceneId:string;sceneTitle:string;sequence:number;durationSeconds:number;prompt:string;negativePrompt:string;camera:string;framing:string;movement:string;lens:string;aspectRatio:string;frameRate:number;resolution:string;visualStyle:string;cameraLanguage:string;shotComposition:string;pacing:string;colorGrade:string;language:string;voiceMode:string;captions:string;music:string;referenceAssetIds:string[];continuityContext:string[]};
export type EpisodeShotPackage={schemaVersion:1;seriesId:string;seriesTitle:string;seasonNumber:number;episodeId:string;episodeNumber:number;episodeTitle:string;runtimeSeconds:number;settings:SeriesDefaults;storyBibleVersion:number;shotCount:number;totalShotSeconds:number;shots:EpisodeShotPackageItem[];createdAt:string};
/** Compile an episode into a deterministic, engine-neutral handoff. No provider is invoked. */
export function buildEpisodeShotPackage(series:SeriesProductionPlan,episode:SeriesEpisode):EpisodeShotPackage{
 const direction=resolveEpisodeDirection(series,episode),season=series.seasons.find(item=>item.episodes.some(ep=>ep.id===episode.id));
 if(!season)throw new Error("Episode does not belong to this series.");
 const bible=series.storyBible?.entries||[],bibleById=new Map(bible.map(entry=>[entry.id,entry])),globalRules=[series.continuityNotes,series.storyBible?.globalRules].filter((rule):rule is string=>Boolean(rule));
 let sequence=0;
 const shots=episode.scenes.flatMap(scene=>scene.shots.map(shot=>{
  sequence++;
  const promptParts=[series.premise,"Series: "+series.title,"Episode: "+episode.title,"Scene: "+scene.title,"Scene purpose: "+scene.purpose,"Shot "+sequence+" action and direction: "+shot.prompt,"Shot camera: "+(shot.camera||direction.cameraLanguage),"Shot framing: "+(shot.framing||direction.shotComposition),"Shot movement: "+(shot.movement||"As defined by the scene action"),"Shot lens: "+(shot.lens||"Natural cinematic perspective"),"Visual style: "+direction.visualStyle,"Camera language: "+direction.cameraLanguage,"Composition: "+direction.shotComposition,"Pacing: "+direction.pacing,"Colour grade: "+direction.colorGrade,"Aspect ratio: "+direction.aspectRatio,"Frame rate: "+direction.frameRate+" fps","Language: "+direction.language,"Voice: "+direction.voiceMode,"Captions: "+direction.captions,"Music: "+direction.music,...globalRules];
  const boundIds=[...new Set([...(scene.storyBibleEntryIds||[]),...(shot.storyBibleEntryIds||[])])],boundEntries=boundIds.map(id=>{const entry=bibleById.get(id);if(!entry)throw new Error("Shot or scene references an unknown story bible entry: "+id);return entry;}),referenceAssetIds=[...new Set(boundEntries.flatMap(entry=>entry.referenceAssetIds))],continuityContext=[...globalRules,...boundEntries.map(entry=>entry.kind.toUpperCase()+" — "+entry.name+": "+entry.description+(entry.visualRules?" Visual rules: "+entry.visualRules:""))];
  return{shotId:shot.id,sceneId:scene.id,sceneTitle:scene.title,sequence,durationSeconds:shot.durationSeconds,prompt:promptParts.filter(Boolean).join("\n"),negativePrompt:shot.negativePrompt||"Do not change established character identity, wardrobe, location geography, props, screen direction, lighting continuity or visual style. Avoid unintended text, logos, watermarks, flicker, warped anatomy and abrupt camera or exposure changes.",camera:shot.camera||direction.cameraLanguage,framing:shot.framing||direction.shotComposition,movement:shot.movement||"As defined by the scene action",lens:shot.lens||"Natural cinematic perspective",aspectRatio:direction.aspectRatio,frameRate:direction.frameRate,resolution:direction.resolution,visualStyle:direction.visualStyle,cameraLanguage:direction.cameraLanguage,shotComposition:direction.shotComposition,pacing:direction.pacing,colorGrade:direction.colorGrade,language:direction.language,voiceMode:direction.voiceMode,captions:direction.captions,music:direction.music,referenceAssetIds,continuityContext};
 }));
 const totalShotSeconds=shots.reduce((sum,shot)=>sum+shot.durationSeconds,0);
 if(totalShotSeconds!==direction.episodeRuntimeSeconds)throw new Error("Shot package duration does not equal the effective episode runtime.");
 return{schemaVersion:1,seriesId:series.id,seriesTitle:series.title,seasonNumber:season.number,episodeId:episode.id,episodeNumber:episode.number,episodeTitle:episode.title,runtimeSeconds:direction.episodeRuntimeSeconds,settings:direction,storyBibleVersion:series.storyBible?.version||1,shotCount:shots.length,totalShotSeconds,shots,createdAt:new Date().toISOString()};
}


export type StoryboardSeriesOptions={
 format?:SeriesFormat;genre?:string;aspectRatio:string;frameRate:number;resolution:string;
 visualStyle:string;language:string;voiceMode:string;captions:string;music:string;
 cameraLanguage:string;shotComposition:string;pacing:string;colorGrade:string;continuityNotes?:string;
};

/** Turn an approved Creative Director storyboard into an editable one-episode production plan. */
export function buildSeriesPlanFromStoryboard(storyboard:CreativeStoryboard,options:StoryboardSeriesOptions):SeriesProductionPlan {
 if(!storyboard||storyboard.schemaVersion!==1||storyboard.planningOnly!==true||storyboard.providerSubmitted!==false)throw new Error("A planning-only Creative Director storyboard is required.");
 if(storyboard.generationState!=="not_submitted"||!Array.isArray(storyboard.scenes)||storyboard.scenes.length<1)throw new Error("Storyboard is not ready for production planning.");
 const plan=buildSeriesProductionPlan({
  title:storyboard.title,premise:storyboard.creativePromise,format:options.format||"documentary",genre:options.genre||"",
  seasonCount:1,episodesPerSeason:1,episodeRuntimeSeconds:storyboard.durationSeconds,shotLengthSeconds:8,
  aspectRatio:options.aspectRatio,frameRate:options.frameRate,resolution:options.resolution,visualStyle:options.visualStyle,
  language:options.language,voiceMode:options.voiceMode,captions:options.captions,music:options.music,
  cameraLanguage:options.cameraLanguage,shotComposition:options.shotComposition,pacing:options.pacing,
  colorGrade:options.colorGrade,continuityNotes:options.continuityNotes||""
 });
 const episode=plan.seasons[0].episodes[0];
 episode.title="Episode 01 · "+storyboard.title;
 episode.logline=storyboard.creativePromise;
 episode.scenes=storyboard.scenes.map(scene=>({
  id:scene.id,title:scene.title,purpose:scene.purpose,durationSeconds:scene.durationSeconds,
  shots:scene.shots.map(shot=>({
   id:shot.id,durationSeconds:shot.durationSeconds,prompt:shot.prompt,status:"planned" as const,
   camera:shot.camera,framing:shot.framing,movement:shot.movement,negativePrompt:shot.negativePrompt
  }))
 }));
 const validation=validateSeriesProductionPlan(plan);
 if(!validation.valid)throw new Error("Storyboard-to-series conversion failed validation: "+validation.issues.join(" "));
 return plan;
}
