const ranges={opacity:[0,1],x:[-100000,100000],y:[-100000,100000],scale:[0.01,20],rotation:[-3600,3600],gainDb:[-60,24],brightness:[0,2],contrast:[0,2],saturation:[0,3]};
const object=value=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
export function validateTimelineClipDescriptors(clip,frameRate,trackKind){
 const issues=[],ids=new Set([clip?.id]),slots=new Set(),fps=Number(frameRate?.numerator)/Number(frameRate?.denominator);
 const seconds=Number(clip?.duration?.value)/Number(clip?.duration?.rate),maxFrames=Number.isFinite(seconds*fps)?Math.max(0,Math.ceil(seconds*fps)):0;
 const add=(id,label)=>{if(typeof id!=="string"||!id.trim()||id.length>128||ids.has(id)){issues.push(label+" IDs must be unique non-empty strings of at most 128 characters.");return;}ids.add(id);};
 if(clip?.effects!==undefined){
  if(Array.isArray(clip.effects)&&clip.effects.length&&trackKind&&trackKind!=="video")issues.push("Color effects are supported only on the primary video track.");
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
   if(trackKind&&(keyframe?.property==="gainDb"?trackKind!=="audio":trackKind==="audio"))issues.push("Keyframe property is not supported on this track kind.");
   if(slots.has(slot))issues.push("A clip cannot define two keyframes for the same property and frame.");
   slots.add(slot);
  }
 }
 for(const [edge,transition] of [["in",clip?.transitionIn],["out",clip?.transitionOut]]){
  if(transition===undefined)continue;
  add(transition?.id,"Transition");
  if(trackKind&&trackKind!=="video")issues.push("Fade-to-black transitions are supported only on the primary video track.");
  if(transition?.schemaVersion!==1||transition?.type!=="fade-to-black"||transition.edge!==edge||
   !Number.isSafeInteger(transition.durationFrames)||transition.durationFrames<1||transition.durationFrames>240||
   transition.durationFrames>maxFrames||transition.durationFrames/fps>seconds+1e-6||transition.curve!=="linear")
   issues.push("Transitions must be version-1 linear fade-to-black descriptors on the matching edge, lasting 1–240 frames and no longer than the clip.");
 }
 const combinedFadeFrames=(clip?.transitionIn?.durationFrames||0)+(clip?.transitionOut?.durationFrames||0);
 if(combinedFadeFrames>seconds*fps+1e-6)issues.push("Fade-in and fade-out durations cannot overlap within a clip.");
 return issues;
}

/** Validate descriptors and refuse keyframes until the renderers support animation evaluation. */
export function assertTimelineDescriptorsSupported(timeline){
 for(const track of timeline?.tracks||[])for(const clip of track?.clips||[]){
  const issues=validateTimelineClipDescriptors(clip,timeline.frameRate,track.kind);
  if(issues.length)throw Object.assign(new Error("Timeline edit descriptors are invalid: "+issues[0]),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
  if(Array.isArray(clip.keyframes)&&clip.keyframes.length)throw Object.assign(new Error("Keyframed properties are not yet supported by the browser preview and master renderer."),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
 }
}

/** Build FFmpeg filters for the currently supported non-destructive color and fade descriptors. */
export function buildTimelineVideoFilters(clip,durationSeconds,frameRate){
 const filters=[],effects=(clip.effects||[]).filter(effect=>effect.enabled!==false);
 let brightness=1,contrast=1,saturation=1;
 for(const effect of effects){
  if(effect.type!=="color")throw Object.assign(new Error("The selected timeline effect is not supported by the master renderer."),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
  brightness*=Number(effect.parameters.brightness);contrast*=Number(effect.parameters.contrast);saturation*=Number(effect.parameters.saturation);
 }
 if(effects.length){
  brightness=Math.max(0,Math.min(4,brightness));contrast=Math.max(0,Math.min(4,contrast));saturation=Math.max(0,Math.min(6,saturation));
  const b=brightness.toFixed(6),c=contrast.toFixed(6),s=saturation.toFixed(6);
  filters.push("lutrgb=r='clip(val*"+b+",0,255)':g='clip(val*"+b+",0,255)':b='clip(val*"+b+",0,255)'");
  filters.push("eq=contrast="+c+":saturation="+s);
 }
 const fps=Number(frameRate),duration=Number(durationSeconds);
 for(const [edge,transition] of [["in",clip.transitionIn],["out",clip.transitionOut]]){
  if(!transition)continue;
  if(transition.type!=="fade-to-black"||transition.edge!==edge||transition.curve!=="linear")throw Object.assign(new Error("The selected transition is not supported by the master renderer."),{code:"UNSUPPORTED_TIMELINE_FEATURE"});
  const fadeDuration=transition.durationFrames/fps;
  if(!Number.isFinite(fadeDuration)||fadeDuration<=0||fadeDuration>duration)throw Object.assign(new Error("Transition duration exceeds the clip duration."),{code:"INVALID_TIMELINE_TRANSITION"});
  const start=edge==="in"?0:Math.max(0,duration-fadeDuration);
  filters.push("fade=t="+(edge==="in"?"in":"out")+":st="+start.toFixed(6)+":d="+fadeDuration.toFixed(6)+":color=black");
 }
 return filters;
}
