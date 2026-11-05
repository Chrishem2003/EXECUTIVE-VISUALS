import { addMarker, addTrack, createTimeline, rational, validateTimeline, type EditorialTimeline, type TimelineMarker } from "./timeline";

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

export function createStoryboardTimeline(projectId:string,timelineId:string,storyboard:StoryboardInput,name?:string):EditorialTimeline{
  if(!projectId||!timelineId)throw fail("A cloud project and new timeline ID are required.");
  if(!storyboard||storyboard.schemaVersion!==1||storyboard.source!=="model"||!storyboard.id||!storyboard.title||!/^([a-f0-9]{64})$/.test(storyboard.inputHash)||typeof storyboard.model!=="string")throw fail("A versioned storyboard with lineage is required.");
  if(!Number.isInteger(storyboard.targetDurationSeconds)||storyboard.targetDurationSeconds<15||storyboard.targetDurationSeconds>1800)throw fail("Storyboard target runtime is invalid.");
  if(!Array.isArray(storyboard.globalContinuityRules)||storyboard.globalContinuityRules.length<3||storyboard.globalContinuityRules.length>10)throw fail("Storyboard continuity rules are invalid.");
  if(!Number.isInteger(storyboard.frameRate)||![24,25,30,50,60].includes(storyboard.frameRate))throw fail("Storyboard frame rate is unsupported.");
  const dimensions=RATIOS[storyboard.aspectRatio];
  if(!dimensions)throw fail("Storyboard aspect ratio is unsupported.");
  if(!Array.isArray(storyboard.scenes)||storyboard.scenes.length<2||storyboard.scenes.length>12)throw fail("Storyboard scene count is invalid.");
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
  if(!plan||plan.schemaVersion!==1||!Number.isInteger(plan.frameRate)||![24,25,30,50,60].includes(plan.frameRate)||!Array.isArray(plan.scenes)||plan.scenes.length<2||plan.scenes.length>12)throw fail("Storyboard timeline plan is invalid.");
  let cursor=0,totalShots=0;
  const scenes=plan.scenes.map(scene=>{
    const startFrame=cursor;
    const shots=scene.shots.map(shot=>{
      totalShots++;
      if(totalShots>60||!Number.isInteger(shot.durationFrames)||shot.durationFrames<1||shot.durationFrames>plan.frameRate*60)throw fail("Planned shot duration or count is invalid.");
      const next={...shot,startFrame:cursor,durationSeconds:shot.durationFrames/plan.frameRate,timelineStart:rational(cursor,plan.frameRate),timelineDuration:rational(shot.durationFrames,plan.frameRate)};
      cursor+=shot.durationFrames;return next;
    });
    const durationFrames=cursor-startFrame;
    return {...scene,startFrame,durationFrames,durationSeconds:durationFrames/plan.frameRate,shots,shotIds:shots.map(shot=>shot.id)};
  });
  return {...plan,scenes,totalFrames:cursor,durationSeconds:cursor/plan.frameRate};
}
