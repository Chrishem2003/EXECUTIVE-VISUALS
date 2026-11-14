import { addMarker, addTrack, createTimeline, rational, validateTimeline, type EditorialTimeline, type TimelineMarker } from "./timeline.ts";

export interface StoryboardShotInput {
  id: string; number: number; durationSeconds: number; shotType: string; framing: string; angle: string;
  movement: string; lens: string; action: string; dialogue: string; narration: string; visualPrompt: string;
  motionPrompt: string; negativePrompt: string; lighting: string; soundCue: string; continuityIn: string;
  continuityOut: string; proofReference: string; transitionOut: string;
  characterRefs: Array<{name:string;characterId:string|null;role:string;action:string;continuityNotes:string}>;
}
export interface StoryboardSceneInput {
  id: string; number: number; title: string; slugline: string; purpose: string; storyBeat: string;
  location: string; timeOfDay: string; durationSeconds: number; shots: StoryboardShotInput[];
}
export interface StoryboardInput {
  schemaVersion: 1; source: "model"; id: string; title: string; logline: string; inputHash: string; model: string; generatedAt: string;
  targetDurationSeconds: number; durationSeconds: number; aspectRatio: string; frameRate: number;
  globalContinuityRules: string[]; scenes: StoryboardSceneInput[];
}
export interface PlannedStoryboardShot extends StoryboardShotInput {
  sourceSceneId: string; sourceShotId: string; sceneNumber: number; shotNumber: number;
  startFrame: number; durationFrames: number; timelineStart: {value:number;rate:number};
  timelineDuration: {value:number;rate:number}; targetTrackId: string; assetId: null; status: "planned";
}
export interface PlannedStoryboardScene extends Omit<StoryboardSceneInput,"shots"> {
  startFrame: number; durationFrames: number; shotIds: string[]; shots: PlannedStoryboardShot[];
}
export interface StoryboardTimelinePlan {
  schemaVersion: 1; sourceStoryboardId: string; sourceInputHash: string; sourceModel: string;
  title: string; logline: string; aspectRatio: string; frameRate: number; targetDurationSeconds: number;
  durationSeconds: number; totalFrames: number; trackIds: {picture:string;audio:string;captions:string};
  globalContinuityRules: string[]; scenes: PlannedStoryboardScene[]; createdAt: string;
}
const RATIOS:Record<string,[number,number]> = {
  "16:9":[1920,1080], "9:16":[1080,1920], "1:1":[1080,1080],
  "4:3":[1440,1080], "3:4":[1080,1440], "21:9":[2560,1080]
};
const fail=(message:string)=>new Error(message);
const validText=(value:unknown,max:number)=>typeof value==="string"&&value.trim().length>0&&value.length<=max;
const validOptionalText=(value:unknown,max:number)=>typeof value==="string"&&value.length<=max;
const validId=(value:unknown)=>validText(value,120)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value as string);
const validUniqueStrings=(values:unknown,min:number,max:number,itemMax:number)=>{
  if(!Array.isArray(values)||values.length<min||values.length>max)return false;
  const normalized=values.map(value=>typeof value==="string"?value.trim():"");
  return normalized.every(value=>value.length>0&&value.length<=itemMax)&&new Set(normalized).size===normalized.length;
};
function validateStoryboardInput(storyboard:StoryboardInput){
  if(!storyboard||storyboard.schemaVersion!==1||storyboard.source!=="model"||!validId(storyboard.id)||!validText(storyboard.title,160)||!validText(storyboard.logline,1000)||!validText(storyboard.model,160)||!/^([a-f0-9]{64})$/.test(storyboard.inputHash))throw fail("A versioned storyboard with valid lineage and bounded title is required.");
  if(!Number.isInteger(storyboard.targetDurationSeconds)||storyboard.targetDurationSeconds<15||storyboard.targetDurationSeconds>1800)throw fail("Storyboard target runtime is invalid.");
  if(!Number.isFinite(Date.parse(storyboard.generatedAt)))throw fail("Storyboard generation timestamp is invalid.");
  if(!validUniqueStrings(storyboard.globalContinuityRules,3,10,400))throw fail("Storyboard continuity rules are invalid.");
  if(!Number.isInteger(storyboard.frameRate)||![24,25,30,50,60].includes(storyboard.frameRate))throw fail("Storyboard frame rate is unsupported.");
  if(!RATIOS[storyboard.aspectRatio])throw fail("Storyboard aspect ratio is unsupported.");
  if(!Array.isArray(storyboard.scenes)||storyboard.scenes.length<2||storyboard.scenes.length>12)throw fail("Storyboard scene count is invalid.");
  const sceneIds=new Set<string>(),shotIds=new Set<string>();
  let totalShots=0,totalFrames=0;
  for(let sceneIndex=0;sceneIndex<storyboard.scenes.length;sceneIndex++){
    const scene=storyboard.scenes[sceneIndex];
    if(!scene||!validId(scene.id)||sceneIds.has(scene.id)||shotIds.has(scene.id)||scene.number!==sceneIndex+1||!validText(scene.title,160)||!validText(scene.slugline,160)||!validText(scene.purpose,500)||!validText(scene.storyBeat,160)||!validOptionalText(scene.location,160)||!validOptionalText(scene.timeOfDay,80)||!Array.isArray(scene.shots)||scene.shots.length<1||scene.shots.length>8)throw fail("Storyboard contains an invalid, duplicate or out-of-order scene.");
    sceneIds.add(scene.id);
    let sceneFrames=0;
    for(let shotIndex=0;shotIndex<scene.shots.length;shotIndex++){
      const shot=scene.shots[shotIndex];
      if(!shot||!validId(shot.id)||shotIds.has(shot.id)||sceneIds.has(shot.id)||shot.number!==shotIndex+1||!Number.isInteger(shot.durationSeconds)||shot.durationSeconds<1||shot.durationSeconds>60)throw fail("Storyboard contains an invalid or duplicate shot, or shots are out of order.");
      for(const [field,max] of Object.entries({shotType:100,framing:120,angle:120,movement:160,lens:100,action:600,dialogue:500,narration:500,visualPrompt:1600,motionPrompt:1000,negativePrompt:600,lighting:300,soundCue:300,continuityIn:300,continuityOut:300,proofReference:300,transitionOut:80})){
        const value=shot[field as keyof StoryboardShotInput];
        if(typeof value!=="string"||value.length>max)throw fail("Storyboard shot "+field+" is invalid or too long.");
      }
      if(!Array.isArray(shot.characterRefs)||shot.characterRefs.length>12||shot.characterRefs.some(reference=>!reference||!validText(reference.name,120)||!validOptionalText(reference.role,160)||(typeof reference.characterId!=="string"&&reference.characterId!==null)||!validOptionalText(reference.action,300)||!validOptionalText(reference.continuityNotes,300)))throw fail("Storyboard shot character references are invalid.");
      shotIds.add(shot.id);totalShots++;
      const frames=Math.round(shot.durationSeconds*storyboard.frameRate);
      if(frames<1)throw fail("Storyboard shot duration is below one frame.");
      sceneFrames+=frames;
    }
    const declaredSceneFrames=Math.round(scene.durationSeconds*storyboard.frameRate);
    if(!Number.isFinite(scene.durationSeconds)||Math.abs(sceneFrames-declaredSceneFrames)>1)throw fail("Storyboard scene duration does not match its shot durations.");
    totalFrames+=sceneFrames;
  }
  if(totalShots>60||totalFrames/storyboard.frameRate>1800)throw fail("Storyboard exceeds the sixty-shot or thirty-minute planning limit.");
  if(!Number.isFinite(storyboard.durationSeconds)||Math.abs(totalFrames/storyboard.frameRate-storyboard.durationSeconds)>1/storyboard.frameRate)throw fail("Storyboard total runtime does not match its shot durations.");
  const tolerance=Math.max(2,Math.round(storyboard.targetDurationSeconds*0.05));
  if(Math.abs(totalFrames/storyboard.frameRate-storyboard.targetDurationSeconds)>tolerance)throw fail("Storyboard runtime does not match its approved target within five percent.");
}

export function createStoryboardTimeline(projectId:string,timelineId:string,storyboard:StoryboardInput,name?:string):EditorialTimeline{
  if(!projectId||!timelineId)throw fail("A cloud project and new timeline ID are required.");
  validateStoryboardInput(storyboard);
  const dimensions=RATIOS[storyboard.aspectRatio];
  const sceneIds=new Set<string>(),shotIds=new Set<string>();
  const fps=storyboard.frameRate;
  let cursor=0,totalShots=0;
  const pictureTrackId=crypto.randomUUID(),audioTrackId=crypto.randomUUID(),captionTrackId=crypto.randomUUID();
  const scenes:PlannedStoryboardScene[]=[];
  const markers:TimelineMarker[]=[];
  for(const scene of storyboard.scenes){
    if(!scene.id||sceneIds.has(scene.id)||!Number.isInteger(scene.number)||scene.number<1||!Array.isArray(scene.shots)||scene.shots.length<1||scene.shots.length>8)throw fail("Storyboard contains an invalid or duplicate scene.");
    sceneIds.add(scene.id);
    const sceneStart=cursor,plannedShots:PlannedStoryboardShot[]=[];
    for(const shot of scene.shots){
      if(!shot.id||shotIds.has(shot.id)||!Number.isInteger(shot.number)||shot.number<1||!Number.isInteger(shot.durationSeconds)||shot.durationSeconds<1||shot.durationSeconds>60)throw fail("Storyboard contains an invalid or duplicate shot.");
      shotIds.add(shot.id);totalShots++;
      if(totalShots>60)throw fail("Storyboard exceeds the sixty-shot timeline planning limit.");
      const durationFrames=Math.max(1,Math.round(shot.durationSeconds*fps));
      const planned:PlannedStoryboardShot={
        ...structuredClone(shot),sourceSceneId:scene.id,sourceShotId:shot.id,sceneNumber:scene.number,shotNumber:shot.number,
        startFrame:cursor,durationFrames,timelineStart:rational(cursor,fps),timelineDuration:rational(durationFrames,fps),
        targetTrackId:pictureTrackId,assetId:null,status:"planned"
      };
      plannedShots.push(planned);cursor+=durationFrames;
    }
    const sceneDurationFrames=cursor-sceneStart;
    scenes.push({
      ...structuredClone(scene),startFrame:sceneStart,durationFrames:sceneDurationFrames,
      durationSeconds:sceneDurationFrames/fps,shotIds:plannedShots.map(shot=>shot.id),shots:plannedShots
    });
    markers.push({
      id:"storyboard-scene-"+scene.id,name:"Scene "+String(scene.number).padStart(2,"0")+" · "+scene.title,
      start:rational(sceneStart,fps),note:scene.purpose
    });
  }
  const durationSeconds=cursor/fps;
  const tolerance=Math.max(2,Math.round(storyboard.targetDurationSeconds*0.05));
  if(Math.abs(durationSeconds-storyboard.targetDurationSeconds)>tolerance)throw fail("Storyboard runtime does not match its approved target within five percent.");
  let timeline=createTimeline(projectId,timelineId,name||storyboard.title+" — Assembly",{numerator:fps,denominator:1});
  timeline.width=dimensions[0];timeline.height=dimensions[1];
  timeline=addTrack(timeline,{id:pictureTrackId,name:"Planned picture",kind:"video",enabled:true,locked:false,clips:[]});
  timeline=addTrack(timeline,{id:audioTrackId,name:"Sound design",kind:"audio",enabled:true,locked:false,clips:[]});
  timeline=addTrack(timeline,{id:captionTrackId,name:"Captions and titles",kind:"caption",enabled:true,locked:false,clips:[]});
  for(const marker of markers)timeline=addMarker(timeline,marker);
  const plan:StoryboardTimelinePlan={
    schemaVersion:1,sourceStoryboardId:storyboard.id,sourceInputHash:storyboard.inputHash,sourceModel:storyboard.model,
    title:storyboard.title,logline:storyboard.logline,aspectRatio:storyboard.aspectRatio,frameRate:fps,
    targetDurationSeconds:storyboard.targetDurationSeconds,durationSeconds,totalFrames:cursor,
    trackIds:{picture:pictureTrackId,audio:audioTrackId,captions:captionTrackId},
    globalContinuityRules:[...storyboard.globalContinuityRules],scenes,createdAt:new Date().toISOString()
  };
  timeline={...timeline,metadata:{...(timeline.metadata||{}),storyboardPlan:plan}};
  const validation=validateTimeline(timeline);
  if(!validation.valid)throw fail("Generated storyboard timeline failed validation: "+validation.issues[0].message);
  return timeline;
}

export function reflowStoryboardTimelinePlan(plan:StoryboardTimelinePlan):StoryboardTimelinePlan{
  if(!plan||plan.schemaVersion!==1||!validId(plan.sourceStoryboardId)||!/^([a-f0-9]{64})$/.test(plan.sourceInputHash)||!validText(plan.sourceModel,160)||!validText(plan.title,160)||!validText(plan.logline,1000))throw fail("Storyboard timeline lineage is invalid.");
  if(!Number.isInteger(plan.frameRate)||![24,25,30,50,60].includes(plan.frameRate)||!Number.isInteger(plan.targetDurationSeconds)||plan.targetDurationSeconds<15||plan.targetDurationSeconds>1800)throw fail("Storyboard timeline frame rate or target runtime is invalid.");
  if(!RATIOS[plan.aspectRatio])throw fail("Storyboard timeline aspect ratio is unsupported.");
  if(!validUniqueStrings(plan.globalContinuityRules,3,10,400))throw fail("Storyboard timeline continuity rules are invalid.");
  if(!plan.trackIds||![plan.trackIds.picture,plan.trackIds.audio,plan.trackIds.captions].every(validId)||new Set(Object.values(plan.trackIds)).size!==3)throw fail("Storyboard timeline track lineage is invalid.");
  if(!Array.isArray(plan.scenes)||plan.scenes.length<2||plan.scenes.length>12)throw fail("Storyboard timeline scene count is invalid.");
  const sceneIds=new Set<string>(),shotIds=new Set<string>();
  let cursor=0,totalShots=0;
  const scenes=plan.scenes.map((scene,sceneIndex)=>{
    if(!scene||!validId(scene.id)||sceneIds.has(scene.id)||shotIds.has(scene.id)||scene.number!==sceneIndex+1||!validText(scene.title,160)||!validText(scene.slugline,160)||!validText(scene.purpose,500)||!validText(scene.storyBeat,160)||!validOptionalText(scene.location,160)||!validOptionalText(scene.timeOfDay,80)||!Array.isArray(scene.shots)||scene.shots.length<1||scene.shots.length>8)throw fail("Storyboard timeline contains an invalid or duplicate scene.");
    sceneIds.add(scene.id);
    const startFrame=cursor;
    const shots=scene.shots.map((shot,shotIndex)=>{
      totalShots++;
      if(totalShots>60||!shot||!validId(shot.id)||shotIds.has(shot.id)||sceneIds.has(shot.id)||shot.number!==shotIndex+1||shot.sourceShotId!==shot.id||shot.sourceSceneId!==scene.id||shot.sceneNumber!==scene.number||shot.shotNumber!==shot.number||shot.targetTrackId!==plan.trackIds.picture||shot.assetId!==null||shot.status!=="planned"||!Number.isInteger(shot.durationFrames)||shot.durationFrames<1||shot.durationFrames>plan.frameRate*60)throw fail("Planned storyboard shot lineage or duration is invalid.");
      shotIds.add(shot.id);
      const next={...shot,startFrame:cursor,durationSeconds:shot.durationFrames/plan.frameRate,timelineStart:rational(cursor,plan.frameRate),timelineDuration:rational(shot.durationFrames,plan.frameRate)};
      cursor+=shot.durationFrames;return next;
    });
    const durationFrames=cursor-startFrame;
    return {...scene,startFrame,durationFrames,durationSeconds:durationFrames/plan.frameRate,shots,shotIds:shots.map(shot=>shot.id)};
  });
  if(totalShots<2||cursor/plan.frameRate>1800)throw fail("Edited storyboard timeline exceeds the sixty-shot or thirty-minute planning limit.");
  return {...plan,scenes,totalFrames:cursor,durationSeconds:cursor/plan.frameRate};
}
