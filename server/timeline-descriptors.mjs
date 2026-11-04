const ranges={opacity:[0,1],x:[-100000,100000],y:[-100000,100000],scale:[0.01,20],rotation:[-3600,3600],gainDb:[-60,24],brightness:[-1,1],contrast:[0,2],saturation:[0,3]};
const object=value=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
export function validateTimelineClipDescriptors(clip,frameRate){
 const issues=[],ids=new Set([clip?.id]),slots=new Set(),fps=Number(frameRate?.numerator)/Number(frameRate?.denominator);
 const seconds=Number(clip?.duration?.value)/Number(clip?.duration?.rate),maxFrames=Number.isFinite(seconds*fps)?Math.max(0,Math.ceil(seconds*fps)):0;
 const add=(id,label)=>{if(typeof id!=="string"||!id.trim()||id.length>128||ids.has(id)){issues.push(label+" IDs must be unique non-empty strings of at most 128 characters.");return;}ids.add(id);};
 if(clip?.effects!==undefined){
  if(!Array.isArray(clip.effects)||clip.effects.length>16)issues.push("A clip may contain no more than 16 effect descriptors.");
  else for(const effect of clip.effects){
   add(effect?.id,"Effect");
   if(effect?.schemaVersion!==1||effect?.type!=="color"||typeof effect.enabled!=="boolean"||!object(effect.parameters)){issues.push("Effect descriptors must use schema version 1, the supported color type, an enabled flag and a parameter object.");continue;}
   const p=effect.parameters,keys=Object.keys(p);
   if(keys.length!==3||keys.some(key=>!["brightness","contrast","saturation"].includes(key))||
    !Number.isFinite(p.brightness)||p.brightness < -1||p.brightness>1||
    !Number.isFinite(p.contrast)||p.contrast<0||p.contrast>2||
    !Number.isFinite(p.saturation)||p.saturation<0||p.saturation>3)issues.push("Color effect parameters must define brightness [-1,1], contrast [0,2] and saturation [0,3].");
  }
 }
 if(clip?.keyframes!==undefined){
  if(!Array.isArray(clip.keyframes)||clip.keyframes.length>1000)issues.push("A clip may contain no more than 1,000 keyframes.");
  else for(const keyframe of clip.keyframes){
   add(keyframe?.id,"Keyframe");
   const range=ranges[keyframe?.property],slot=keyframe?.property+":"+keyframe?.frame;
   if(keyframe?.schemaVersion!==1||!range||!Number.isSafeInteger(keyframe.frame)||keyframe.frame<0||keyframe.frame>maxFrames||
    !Number.isFinite(keyframe.value)||keyframe.value<range[0]||keyframe.value>range[1]||!["hold","linear"].includes(keyframe.interpolation))
    issues.push("Keyframes must use schema version 1, a supported property, an in-range integer frame, a bounded finite value and hold or linear interpolation.");
   if(slots.has(slot))issues.push("A clip cannot define two keyframes for the same property and frame.");
   slots.add(slot);
  }
 }
 for(const [edge,transition] of [["in",clip?.transitionIn],["out",clip?.transitionOut]]){
  if(transition===undefined)continue;
  add(transition?.id,"Transition");
  if(transition?.schemaVersion!==1||transition?.type!=="fade-to-black"||transition.edge!==edge||
   !Number.isSafeInteger(transition.durationFrames)||transition.durationFrames<1||transition.durationFrames>240||
   transition.durationFrames>maxFrames||transition.curve!=="linear")
   issues.push("Transitions must be version-1 linear fade-to-black descriptors on the matching edge, lasting 1–240 frames and no longer than the clip.");
 }
 return issues;
}

/** Prevent renderers from silently dropping edit descriptors they cannot yet render. */
export function assertTimelineDescriptorsSupported(timeline){
 for(const track of timeline?.tracks||[])for(const clip of track?.clips||[]){
  const hasEffects=clip?.effects!==undefined&&(!Array.isArray(clip.effects)||clip.effects.length>0);
  const hasKeyframes=clip?.keyframes!==undefined&&(!Array.isArray(clip.keyframes)||clip.keyframes.length>0);
  if(hasEffects||hasKeyframes||clip?.transitionIn||clip?.transitionOut){
   throw Object.assign(new Error("This timeline contains versioned effects, keyframes or transitions that the current master renderer cannot yet reproduce. Remove or disable those descriptors before rendering."),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
  }
 }
}
