export type SeriesFormat="documentary"|"docuseries"|"education"|"fiction"|"interview"|"brand"|"children"|"shorts";
export type SeriesDefaults={episodeRuntimeSeconds:number;shotLengthSeconds:number;aspectRatio:string;frameRate:number;resolution:string;visualStyle:string;language:string;voiceMode:string;captions:string;music:string;cameraLanguage:string;shotComposition:string;pacing:string;colorGrade:string};
export type EpisodeShot={id:string;durationSeconds:number;prompt:string;status:"planned"};
export type EpisodeScene={id:string;title:string;purpose:string;durationSeconds:number;shots:EpisodeShot[]};
export type EpisodeDirectionOverrides=Partial<Pick<SeriesDefaults,"episodeRuntimeSeconds"|"aspectRatio"|"frameRate"|"resolution"|"visualStyle"|"cameraLanguage"|"shotComposition"|"pacing"|"colorGrade"|"language"|"voiceMode"|"captions"|"music">>;
export type StoryBibleKind="character"|"location"|"prop"|"wardrobe"|"voice"|"brand-rule";
export type StoryBibleEntry={id:string;kind:StoryBibleKind;name:string;description:string;visualRules:string;referenceAssetIds:string[];tags:string[];createdAt:string;updatedAt:string};
export type SeriesStoryBible={version:1;entries:StoryBibleEntry[];globalRules:string;updatedAt:string};
export type SeriesEpisode={id:string;number:number;title:string;runtimeSeconds:number;status:"planned";logline?:string;recap?:string;nextHook?:string;overrides?:EpisodeDirectionOverrides;scenes:EpisodeScene[]};
export type SeriesSeason={id:string;number:number;title:string;episodes:SeriesEpisode[]};
export type SeriesProductionPlan={id:string;schemaVersion:1;title:string;premise:string;format:SeriesFormat;genre:string;continuityNotes:string;defaults:SeriesDefaults;seasons:SeriesSeason[];storyBible?:SeriesStoryBible;seasonArcs?:Record<string,string>;createdAt:string;updatedAt:string};
export type SeriesProductionInput={title:string;premise:string;format:string;genre?:string;seasonCount:number;episodesPerSeason:number;episodeRuntimeSeconds:number;shotLengthSeconds:number;aspectRatio:string;frameRate:number;resolution:string;visualStyle:string;language:string;voiceMode:string;captions:string;music:string;cameraLanguage:string;shotComposition:string;pacing:string;colorGrade:string;continuityNotes?:string};
export const MAX_EPISODE_SECONDS=300,MAX_GENERATED_CLIP_SECONDS=30;
export const EPISODE_RUNTIME_CHOICES=Object.freeze([30,60,90,120,180,240,300]);
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
 const issues:string[]=[],ids=new Set<string>(),unique=(id:string,label:string)=>{if(typeof id!=="string"||!id.trim()||ids.has(id))issues.push(label+" IDs must be unique and non-empty.");else ids.add(id);};
 if(!plan||plan.schemaVersion!==1)issues.push("Unsupported series plan schema.");
 if(!Array.isArray(plan.seasons)||plan.seasons.length<1||plan.seasons.length>5)issues.push("A series must contain 1–5 seasons.");
 for(const season of plan.seasons||[]){unique(season.id,"Season");if(!Array.isArray(season.episodes)||season.episodes.length>20)issues.push("Each season may contain at most 20 episodes.");
 for(const episode of season.episodes||[]){unique(episode.id,"Episode");if(!Number.isInteger(episode.runtimeSeconds)||episode.runtimeSeconds<1||episode.runtimeSeconds>MAX_EPISODE_SECONDS)issues.push("Episode runtime must not exceed 300 seconds.");if(!Array.isArray(episode.scenes)||!episode.scenes.length)issues.push("Every episode requires a scene.");let total=0;
 for(const scene of episode.scenes||[]){unique(scene.id,"Scene");if(!Array.isArray(scene.shots)||!scene.shots.length)issues.push("Every scene requires a shot.");let sceneTotal=0;
 for(const shot of scene.shots||[]){unique(shot.id,"Shot");if(!Number.isInteger(shot.durationSeconds)||shot.durationSeconds<1||shot.durationSeconds>MAX_GENERATED_CLIP_SECONDS)issues.push("Each clip must be 1–30 seconds.");sceneTotal+=Number(shot.durationSeconds)||0;}
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

const BIBLE_KINDS=new Set<StoryBibleKind>(["character","location","prop","wardrobe","voice","brand-rule"]);
const OVERRIDE_TEXT_LIMITS:Partial<Record<keyof SeriesDefaults,number>>={aspectRatio:8,resolution:20,visualStyle:80,cameraLanguage:100,shotComposition:100,pacing:100,colorGrade:100,language:40,voiceMode:80,captions:80,music:100};
/** Merge episode-specific direction over series defaults without mutating either record. */
export function resolveEpisodeDirection(series:SeriesProductionPlan,episode:SeriesEpisode):SeriesDefaults{
 if(!series.seasons.some(season=>season.episodes.some(item=>item.id===episode.id)))throw new Error("Episode does not belong to this series.");
 const merged={...series.defaults,...(episode.overrides||{})};
 if(!Number.isInteger(merged.episodeRuntimeSeconds)||merged.episodeRuntimeSeconds<15||merged.episodeRuntimeSeconds>MAX_EPISODE_SECONDS)throw new Error("Episode runtime override must be 15–300 seconds.");
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
 for(const [rawKey,value] of Object.entries(overrides)){const key=rawKey as keyof SeriesDefaults;if(!allowed.has(key))throw new Error("Unsupported episode override.");if(key==="episodeRuntimeSeconds"){if(!Number.isInteger(value)||Number(value)<15||Number(value)>MAX_EPISODE_SECONDS||!EPISODE_RUNTIME_CHOICES.includes(Number(value)))throw new Error("Episode runtime override must be a supported value up to five minutes.");(clean as Record<string,unknown>)[key]=value;}else if(key==="frameRate"){if(!Number.isInteger(value)||Number(value)<1||Number(value)>120)throw new Error("Frame-rate override must be 1–120.");(clean as Record<string,unknown>)[key]=value;}else{const limit=OVERRIDE_TEXT_LIMITS[key]||100;if(typeof value!=="string"||!value.trim()||value.length>limit)throw new Error("Invalid "+key+" override.");(clean as Record<string,unknown>)[key]=value.trim();}}
 const next={...series,seasons:series.seasons.map(season=>({...season,episodes:season.episodes.map(episode=>{if(episode.id!==episodeId)return episode;found=true;let scenes=episode.scenes;if(clean.episodeRuntimeSeconds!==undefined&&clean.episodeRuntimeSeconds!==episode.runtimeSeconds){const weights=episode.scenes.map(scene=>Math.max(1,scene.durationSeconds)),durations=allocate(clean.episodeRuntimeSeconds,weights);scenes=episode.scenes.map((scene,index)=>{const durationSeconds=durations[index],count=Math.ceil(durationSeconds/Math.min(series.defaults.shotLengthSeconds,MAX_GENERATED_CLIP_SECONDS)),shotDurations=allocate(durationSeconds,Array(count).fill(1));return{...scene,durationSeconds,shots:shotDurations.map((durationSeconds,shotIndex)=>({id:scene.id+"-override-shot-"+(shotIndex+1),durationSeconds,prompt:scene.shots[Math.min(shotIndex,scene.shots.length-1)]?.prompt||"Add shot direction.",status:"planned" as const}))};});}return{...episode,runtimeSeconds:clean.episodeRuntimeSeconds??episode.runtimeSeconds,scenes,overrides:Object.keys(clean).length?clean:undefined};})})),updatedAt:new Date().toISOString()};
 if(!found)throw new Error("Episode does not belong to this series.");
 const episode=next.seasons.flatMap(season=>season.episodes).find(item=>item.id===episodeId)!;resolveEpisodeDirection(next,episode);
 return next;
}
