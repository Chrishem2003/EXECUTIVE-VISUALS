import type { TimelineClip, TimelineIssue } from "./timeline";

export type TimelineAnimatedProperty="opacity"|"x"|"y"|"scale"|"rotation"|"gainDb"|"brightness"|"contrast"|"saturation";
export interface TimelineColorEffectDescriptor {
  schemaVersion:1;
  id:string;
  type:"color";
  enabled:boolean;
  parameters:{brightness:number;contrast:number;saturation:number};
}
export interface TimelineKeyframeDescriptor {
  schemaVersion:1;
  id:string;
  property:TimelineAnimatedProperty;
  frame:number;
  value:number;
  interpolation:"hold"|"linear";
}
export interface TimelineTransitionDescriptor {
  schemaVersion:1;
  id:string;
  type:"fade-to-black";
  edge:"in"|"out";
  durationFrames:number;
  curve:"linear";
}

const ranges:Record<TimelineAnimatedProperty,[number,number]>={
  opacity:[0,1],x:[-100000,100000],y:[-100000,100000],scale:[0.01,20],
  rotation:[-3600,3600],gainDb:[-60,24],brightness:[-1,1],contrast:[0,2],saturation:[0,3]
};
const isObject=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);

/** Validate versioned clip-level editing descriptors without silently accepting unknown fields. */
export function validateTimelineDescriptors(clip:TimelineClip,frameRate:{numerator:number;denominator:number}):TimelineIssue[]{
  const issues:TimelineIssue[]=[],ids=new Set<string>([clip.id]),keyframeSlots=new Set<string>();
  const durationSeconds=clip.duration.value/clip.duration.rate,fps=frameRate.numerator/frameRate.denominator;
  const maxFrames=Number.isFinite(durationSeconds*fps)?Math.max(0,Math.ceil(durationSeconds*fps)):0;
  const addId=(id:unknown,label:string)=>{
    if(typeof id!=="string"||!id.trim()||id.length>128||ids.has(id)){
      issues.push({code:"invalid_descriptor_id",clipId:clip.id,message:label+" IDs must be unique non-empty strings of at most 128 characters."});
      return false;
    }
    ids.add(id);return true;
  };
  if(clip.effects!==undefined){
    if(!Array.isArray(clip.effects)||clip.effects.length>16)issues.push({code:"invalid_effects",clipId:clip.id,message:"A clip may contain no more than 16 effect descriptors."});
    else for(const effect of clip.effects){
      addId(effect?.id,"Effect");
      if(effect?.schemaVersion!==1||effect?.type!=="color"||typeof effect.enabled!=="boolean"||!isObject(effect.parameters)){
        issues.push({code:"invalid_effect_descriptor",clipId:clip.id,message:"Effect descriptors must use schema version 1, the supported color type, an enabled flag and a parameter object."});continue;
      }
      const keys=Object.keys(effect.parameters);
      if(keys.some(key=>!["brightness","contrast","saturation"].includes(key))||keys.length!==3||
        !Number.isFinite(effect.parameters.brightness)||effect.parameters.brightness < -1||effect.parameters.brightness>1||
        !Number.isFinite(effect.parameters.contrast)||effect.parameters.contrast<0||effect.parameters.contrast>2||
        !Number.isFinite(effect.parameters.saturation)||effect.parameters.saturation<0||effect.parameters.saturation>3){
        issues.push({code:"invalid_effect_parameters",clipId:clip.id,message:"Color effect parameters must define brightness [-1,1], contrast [0,2] and saturation [0,3]."});
      }
    }
  }
  if(clip.keyframes!==undefined){
    if(!Array.isArray(clip.keyframes)||clip.keyframes.length>1000)issues.push({code:"invalid_keyframes",clipId:clip.id,message:"A clip may contain no more than 1,000 keyframes."});
    else for(const keyframe of clip.keyframes){
      addId(keyframe?.id,"Keyframe");
      const property=keyframe?.property as TimelineAnimatedProperty;
      const range=ranges[property],slot=property+":"+keyframe?.frame;
      if(keyframe?.schemaVersion!==1||!range||!Number.isSafeInteger(keyframe.frame)||keyframe.frame<0||keyframe.frame>maxFrames||
        !Number.isFinite(keyframe.value)||keyframe.value<range[0]||keyframe.value>range[1]||
        !["hold","linear"].includes(keyframe.interpolation)){
        issues.push({code:"invalid_keyframe",clipId:clip.id,message:"Keyframes must use schema version 1, a supported property, an in-range integer frame, a bounded finite value and hold or linear interpolation."});
      }
      if(keyframeSlots.has(slot))issues.push({code:"duplicate_keyframe",clipId:clip.id,message:"A clip cannot define two keyframes for the same property and frame."});
      keyframeSlots.add(slot);
    }
  }
  for(const [edge,transition] of [["in",clip.transitionIn],["out",clip.transitionOut]] as const){
    if(transition===undefined)continue;
    addId(transition?.id,"Transition");
    if(transition?.schemaVersion!==1||transition?.type!=="fade-to-black"||transition.edge!==edge||
      !Number.isSafeInteger(transition.durationFrames)||transition.durationFrames<1||transition.durationFrames>240||
      transition.durationFrames>maxFrames||transition.curve!=="linear"){
      issues.push({code:"invalid_transition",clipId:clip.id,message:"Transitions must be version-1 linear fade-to-black descriptors on the matching edge, lasting 1–240 frames and no longer than the clip."});
    }
  }
  return issues;
}
