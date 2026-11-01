const clean=(value,max=2000)=>String(value??"").trim().slice(0,max);
const line=(label,value,max)=>{const text=clean(value,max);return text?label+": "+text:"";};
export function buildShotContinuityPrompt({document,shotId,prompt}={}){
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
