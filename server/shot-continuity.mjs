const clean=(value,max=2000)=>String(value??"").trim().slice(0,max);
const line=(label,value,max)=>{const text=clean(value,max);return text?label+": "+text:"";};
export function buildShotContinuityPrompt({document,shotId,prompt,authorizeCharacter}={}){
 const id=clean(shotId,80);
 if(!id)throw Object.assign(new Error("A shot ID is required to build continuity context."),{code:"SHOT_CONTEXT_REQUIRED"});
 const shots=Array.isArray(document?.shots)?document.shots:[];
 const matches=shots.filter(item=>clean(item?.id,80)===id);
 if(matches.length!==1)throw Object.assign(new Error("The selected shot is missing or ambiguous in this project workspace."),{code:"SHOT_CONTEXT_NOT_FOUND"});
 const shot=matches[0];
 const characters=Array.isArray(document?.characters)?document.characters:[];
 const linkedIds=[...new Set((Array.isArray(shot.characterIds)?shot.characterIds:[]).map(value=>clean(value,80)).filter(Boolean))];
 const selected=[];
 for(const characterId of linkedIds){
  const found=characters.filter(item=>clean(item?.id,80)===characterId);
  if(found.length!==1)throw Object.assign(new Error("A linked shot character is missing or ambiguous in this project workspace."),{code:"SHOT_CHARACTER_NOT_FOUND"});
  if(typeof authorizeCharacter==="function")authorizeCharacter(found[0]);
  selected.push(found[0]);
 }
 const sections=[];
 const shotLines=[
  line("Scene",shot.scene,200),line("Action",shot.action,1500),line("Location",shot.location,300),
  line("Time of day",shot.timeOfDay,120),line("Visual direction",shot.visualPrompt,3000),
  line("Camera",shot.camera,300),line("Lens",shot.lens,120),line("Movement",shot.movement,300),
  line("Lighting",shot.lighting,500),line("Aspect ratio",shot.aspectRatio,20),
  line("Continuity entering this shot",shot.continuityIn,1000),line("Continuity leaving this shot",shot.continuityOut,1000)
 ].filter(Boolean);
 if(shotLines.length)sections.push("SHOT CONTINUITY\n"+shotLines.join("\n"));
 const characterSections=selected.map((character,index)=>{
  const fields=[
   line("Name",character.name,160),line("Description",character.description,1200),
   line("Appearance",character.appearance,1200),line("Wardrobe",character.wardrobe,1200),
   line("Voice profile",character.voiceProfile,800),line("Continuity notes",character.continuityNotes,1200)
  ].filter(Boolean);
  return "CHARACTER "+(index+1)+"\n"+fields.join("\n");
 });
 sections.push(...characterSections);
 const source=clean(prompt,20000);
 if(!source)throw Object.assign(new Error("Generation requires a non-empty user prompt."),{code:"PROMPT_REQUIRED"});
 const context=sections.join("\n\n").slice(0,12000);
 return context?source+"\n\nUse the following saved project continuity as visual production context. Preserve the selected character identities, wardrobe and shot details.\n"+context:source;
}

export function getShotContinuityReferenceIds({document,shotId}={}){
 const id=clean(shotId,80);
 if(!id)throw Object.assign(new Error("A shot ID is required to resolve continuity references."),{code:"SHOT_CONTEXT_REQUIRED"});
 const shots=Array.isArray(document?.shots)?document.shots:[];
 const matches=shots.filter(item=>clean(item?.id,80)===id);
 if(matches.length!==1)throw Object.assign(new Error("The selected shot is missing or ambiguous in this project workspace."),{code:"SHOT_CONTEXT_NOT_FOUND"});
 const shot=matches[0],characters=Array.isArray(document?.characters)?document.characters:[];
 const ids=[...(Array.isArray(shot.referenceAssetIds)?shot.referenceAssetIds:[])];
 for(const characterId of [...new Set((Array.isArray(shot.characterIds)?shot.characterIds:[]).map(value=>clean(value,80)).filter(Boolean))]){
  const found=characters.filter(item=>clean(item?.id,80)===characterId);
  if(found.length!==1)throw Object.assign(new Error("A linked shot character is missing or ambiguous in this project workspace."),{code:"SHOT_CHARACTER_NOT_FOUND"});
  if(Array.isArray(found[0].referenceAssetIds))ids.push(...found[0].referenceAssetIds);
 }
 return [...new Set(ids.map(value=>clean(value,80)).filter(Boolean))].slice(0,40);
}

const CONTINUITY_FIELDS=["identity","wardrobe","location","props","lighting","colorGrade"];
export function buildShotContinuityReport(shots=[]){
 if(!Array.isArray(shots))throw new TypeError("shots must be an array");
 if(shots.length>500)throw new RangeError("continuity analysis is limited to 500 shots per report");
 const groups=new Map(),findings=[];
 for(const [index,shot] of shots.entries()){
  if(!shot||typeof shot!=="object"||Array.isArray(shot))throw new TypeError("each shot must be an object");
  const id=clean(shot.id,80)||"shot-"+(index+1),group=clean(shot.continuityGroup,80)||"default",values={};
  for(const field of CONTINUITY_FIELDS)values[field]=clean(shot.continuity?.[field],240);
  if(!groups.has(group))groups.set(group,{baseline:{id,values},shots:[]});
  groups.get(group).shots.push({id,values});
 }
 for(const [group,data] of groups){
  const baseline=data.baseline;
  for(const field of CONTINUITY_FIELDS)if(!baseline.values[field])findings.push({code:"CONTINUITY_REFERENCE_MISSING",severity:"info",group,shotId:baseline.id,field});
  for(const shot of data.shots.slice(1))for(const field of CONTINUITY_FIELDS){
   const expected=baseline.values[field],actual=shot.values[field];
   if(expected&&actual&&expected.toLocaleLowerCase()!==actual.toLocaleLowerCase())findings.push({code:"CONTINUITY_VARIATION",severity:"warning",group,referenceShotId:baseline.id,shotId:shot.id,field,expected,actual});
  }
 }
 return {schemaVersion:1,method:"declared-shot-metadata-comparison",shotCount:shots.length,groupCount:groups.size,status:findings.some(item=>item.severity==="warning")?"review":"informational",findings,limitations:["Metadata comparison only; no image pixels are inspected and no visual identity, wardrobe or prop recognition is claimed.","Camera framing and movement are intentionally allowed to vary.","Human creative review decides whether a variation is intentional."]};
}
