export type SeriesFormat="documentary"|"docuseries"|"education"|"fiction"|"interview"|"brand"|"children"|"shorts";
export type SeriesDefaults={episodeRuntimeSeconds:number;shotLengthSeconds:number;aspectRatio:string;frameRate:number;resolution:string;visualStyle:string;language:string;voiceMode:string;captions:string;music:string};
export type EpisodeShot={id:string;durationSeconds:number;prompt:string;status:"planned"};
export type EpisodeScene={id:string;title:string;purpose:string;durationSeconds:number;shots:EpisodeShot[]};
export type SeriesEpisode={id:string;number:number;title:string;runtimeSeconds:number;status:"planned";scenes:EpisodeScene[]};
export type SeriesSeason={id:string;number:number;title:string;episodes:SeriesEpisode[]};
export type SeriesProductionPlan={id:string;schemaVersion:1;title:string;premise:string;format:SeriesFormat;genre:string;continuityNotes:string;defaults:SeriesDefaults;seasons:SeriesSeason[];createdAt:string;updatedAt:string};
export type SeriesProductionInput={title:string;premise:string;format:string;genre?:string;seasonCount:number;episodesPerSeason:number;episodeRuntimeSeconds:number;shotLengthSeconds:number;aspectRatio:string;frameRate:number;resolution:string;visualStyle:string;language:string;voiceMode:string;captions:string;music:string;continuityNotes?:string};
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
 const defaults:SeriesDefaults={episodeRuntimeSeconds:runtime,shotLengthSeconds:shot,aspectRatio:input.aspectRatio,frameRate,resolution:text(input.resolution,20,"Resolution"),visualStyle:text(input.visualStyle,80,"Visual style"),language:text(input.language,40,"Language"),voiceMode:text(input.voiceMode,80,"Voice approach"),captions:text(input.captions,80,"Caption mode"),music:text(input.music,100,"Music direction")},now=new Date().toISOString();
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
