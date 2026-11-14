const text=(value,max)=>String(value??"").slice(0,max);
const records=(value,limit,fields)=>Array.isArray(value)?value.slice(0,limit).filter(item=>item&&typeof item==="object"&&!Array.isArray(item)).map(item=>Object.fromEntries(fields.map(([key,max])=>[key,text(item[key],max)]))):[];
const stringList=(value,limit=30,max=240)=>Array.isArray(value)?[...new Set(value.slice(0,limit).map(item=>text(item,max).trim()).filter(Boolean))]:[];
function boundedProjectValue(value,depth=0,budget={nodes:0}){
 budget.nodes++;
 if(budget.nodes>12000||depth>10)throw Object.assign(new Error("Creative project artifact is too complex to store safely."),{code:"WORKSPACE_ARTIFACT_INVALID"});
 if(value===null||typeof value==="boolean")return value;
 if(typeof value==="number"){if(!Number.isFinite(value))throw Object.assign(new Error("Creative project artifact contains an invalid number."),{code:"WORKSPACE_ARTIFACT_INVALID"});return value;}
 if(typeof value==="string"){if(value.length>6000)throw Object.assign(new Error("Creative project artifact contains an oversized text field."),{code:"WORKSPACE_ARTIFACT_INVALID"});return value;}
 if(Array.isArray(value)){if(value.length>200)throw Object.assign(new Error("Creative project artifact contains an oversized list."),{code:"WORKSPACE_ARTIFACT_INVALID"});return value.map(item=>boundedProjectValue(item,depth+1,budget));}
 if(!value||typeof value!=="object"||Object.getPrototypeOf(value)!==Object.prototype)throw Object.assign(new Error("Creative project artifact contains an invalid object."),{code:"WORKSPACE_ARTIFACT_INVALID"});
 const entries=Object.entries(value);
 if(entries.length>120)throw Object.assign(new Error("Creative project artifact contains too many fields."),{code:"WORKSPACE_ARTIFACT_INVALID"});
 const output={};
 for(const [key,item] of entries){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(key)||["__proto__","prototype","constructor"].includes(key))continue;
  output[key]=boundedProjectValue(item,depth+1,budget);
 }
 return output;
}
function creativeProjects(value){
 if(!Array.isArray(value))return [];
 return value.slice(0,100).filter(item=>item&&typeof item==="object"&&!Array.isArray(item)).map(item=>{
  const project={
   id:text(item.id,80),name:text(item.name,160),brief:text(item.brief,10000),
   audience:text(item.audience,2000),style:text(item.style,200),created:text(item.created,40)
  };
  for(const key of ["creativeDNA","creativeBriefInput","modelCreativeDirection","storyboard","modelStoryboard"]){
   if(item[key]!==undefined&&item[key]!==null){
    const artifact=boundedProjectValue(item[key]);
    if(Buffer.byteLength(JSON.stringify(artifact),"utf8")>512*1024)throw Object.assign(new Error("A creative project artifact exceeds the 512 KiB limit."),{code:"WORKSPACE_ARTIFACT_TOO_LARGE"});
    project[key]=artifact;
   }
  }
  return project;
 });
}
export function sanitizeCreativeWorkspaceDocument(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw Object.assign(new Error("Workspace document must be a JSON object."),{code:"INVALID_WORKSPACE_DOCUMENT"});
 const sourceRows=Array.isArray(input.researchSources)?input.researchSources.slice(0,300).filter(item=>item&&typeof item==="object"&&!Array.isArray(item)):[];
 const sources=sourceRows.map(item=>{const url=text(item.url,2048);let parsed;try{parsed=new URL(url);}catch{throw Object.assign(new Error("Research source URL must be a valid HTTP or HTTPS URL."),{code:"INVALID_RESEARCH_SOURCE_URL"});}if(!["http:","https:"].includes(parsed.protocol))throw Object.assign(new Error("Research source URL must use HTTP or HTTPS."),{code:"INVALID_RESEARCH_SOURCE_URL"});return {id:text(item.id,80),title:text(item.title,240),url:parsed.toString(),sourceType:text(item.sourceType,80),author:text(item.author,240),publishedAt:text(item.publishedAt,40),accessedAt:text(item.accessedAt,40),summary:text(item.summary,4000),rights:text(item.rights,500),createdAt:text(item.createdAt,40)};});
 const sourceIds=new Set(sources.map(item=>item.id));
 const knowledgeRows=Array.isArray(input.knowledgeRecords)?input.knowledgeRecords.slice(0,500).filter(item=>item&&typeof item==="object"&&!Array.isArray(item)):[];
 const knowledgeRecords=knowledgeRows.map(item=>({id:text(item.id,80),title:text(item.title,240),content:text(item.content,12000),tags:Array.isArray(item.tags)?item.tags.slice(0,30).map(value=>text(value,80)):[],sourceIds:Array.isArray(item.sourceIds)?item.sourceIds.slice(0,100).map(value=>text(value,80)).filter(id=>sourceIds.has(id)):[],kind:text(item.kind,80),status:text(item.status,80),createdAt:text(item.createdAt,40),updatedAt:text(item.updatedAt,40)}));
 if(knowledgeRecords.some(item=>item.status==="Verified"&&item.sourceIds.length===0))throw Object.assign(new Error("Verified knowledge records must cite at least one saved project source."),{code:"KNOWLEDGE_EVIDENCE_REQUIRED"});
 const rawBrand=input.brandKit&&typeof input.brandKit==="object"&&!Array.isArray(input.brandKit)?input.brandKit:{};
 const color=(value,fallback)=>{const candidate=String(value??"").trim();if(!candidate)return fallback;if(candidate.length!==7||!/^#[0-9a-fA-F]{6}$/.test(candidate))throw Object.assign(new Error("Brand colors must use six-digit hexadecimal values."),{code:"INVALID_BRAND_COLOR"});return candidate.toUpperCase();};
 const brandKit={
  version:1,name:text(rawBrand.name,120).trim(),tagline:text(rawBrand.tagline,240).trim(),
  voice:text(rawBrand.voice,1200).trim(),visualStyle:text(rawBrand.visualStyle,1200).trim(),
  colors:{primary:color(rawBrand.colors?.primary,"#202124"),secondary:color(rawBrand.colors?.secondary,"#5F6368"),accent:color(rawBrand.colors?.accent,"#7C5CFC"),background:color(rawBrand.colors?.background,"#FFFFFF"),text:color(rawBrand.colors?.text,"#202124")},
  typography:{heading:text(rawBrand.typography?.heading,80).trim(),body:text(rawBrand.typography?.body,80).trim()},
  logoAssetIds:stringList(rawBrand.logoAssetIds,12,80),prohibitedTerms:stringList(rawBrand.prohibitedTerms,40,120),
  legalFooter:text(rawBrand.legalFooter,600).trim(),updatedAt:text(rawBrand.updatedAt,40)
 };
 const templateRows=Array.isArray(input.campaignTemplates)?input.campaignTemplates.slice(0,40).filter(item=>item&&typeof item==="object"&&!Array.isArray(item)):[];
 const campaignTemplates=templateRows.map(item=>{
  const width=Math.max(1,Math.min(8192,Math.trunc(Number(item.width)||1080)));
  const height=Math.max(1,Math.min(8192,Math.trunc(Number(item.height)||1920)));
  const aspectRatio=text(item.aspectRatio,12).trim();
  if(!/^\d{1,5}:\d{1,5}$/.test(aspectRatio))throw Object.assign(new Error("Campaign template aspect ratio must use W:H notation."),{code:"INVALID_CAMPAIGN_TEMPLATE"});
  const safe=value=>Math.max(0,Math.min(40,Number(value)||0));
  return {id:text(item.id,80),name:text(item.name,120).trim(),channel:text(item.channel,80).trim(),aspectRatio,width,height,maxDurationSeconds:Math.max(1,Math.min(3600,Math.trunc(Number(item.maxDurationSeconds)||60))),safeArea:{top:safe(item.safeArea?.top),right:safe(item.safeArea?.right),bottom:safe(item.safeArea?.bottom),left:safe(item.safeArea?.left)},subtitleSafeArea:Boolean(item.subtitleSafeArea),enabled:item.enabled!==false};
 });
 const document={
  schemaVersion:1,
  creativeProjects:creativeProjects(input.creativeProjects),
  tasks:records(input.tasks,500,[["id",80],["name",200],["category",120],["status",40],["created",40],["detail",4000]]),
  shots:records(input.shots,500,[["id",80],["scene",200],["action",4000],["camera",300],["lens",120],["movement",300],["lighting",500]]).map((item,index)=>({
   ...item,
   duration:Math.max(0,Math.min(3600,Number(input.shots[index]?.duration)||0)),
   characterIds:stringList(input.shots[index]?.characterIds,30,80),
   location:text(input.shots[index]?.location,300),
   timeOfDay:text(input.shots[index]?.timeOfDay,120),
   visualPrompt:text(input.shots[index]?.visualPrompt,6000),
   continuityIn:text(input.shots[index]?.continuityIn,2000),
   continuityOut:text(input.shots[index]?.continuityOut,2000),
   referenceAssetIds:stringList(input.shots[index]?.referenceAssetIds,20,80),
   aspectRatio:text(input.shots[index]?.aspectRatio,20)
  })),
  characters:records(input.characters,200,[["id",80],["name",160],["description",6000],["voice",160]]).map((item,index)=>{
   const raw=input.characters[index]?.consent;
   const consent=raw&&typeof raw==="object"&&!Array.isArray(raw)?{
    kind:["fictional","authorized","not-granted"].includes(raw.kind)?raw.kind:"not-granted",
    scopes:Array.isArray(raw.scopes)?[...new Set(raw.scopes.filter(scope=>["likeness","voice","face-animation","lip-sync","identity-transfer"].includes(scope)))].slice(0,5):[],
    evidenceReference:text(raw.evidenceReference,500),
    expiresAt:text(raw.expiresAt,10)
   }:{kind:"not-granted",scopes:[],evidenceReference:"",expiresAt:""};
   return {...item,appearance:text(input.characters[index]?.appearance,3000),wardrobe:text(input.characters[index]?.wardrobe,3000),voiceProfile:text(input.characters[index]?.voiceProfile,2000),continuityNotes:text(input.characters[index]?.continuityNotes,3000),referenceAssetIds:stringList(input.characters[index]?.referenceAssetIds,20,80),consent};
  }),
  prompt:text(input.prompt,20000),
  plan:text(input.plan,50000),
  script:text(input.script,50000),
  variants:Array.isArray(input.variants)?input.variants.slice(0,100).map(value=>text(value,4000)):[],
  researchSources:sources,
  knowledgeRecords,
  brandKit,
  campaignTemplates,
 };
 if(Buffer.byteLength(JSON.stringify(document),"utf8")>2*1024*1024)throw Object.assign(new Error("Workspace document exceeds the 2 MiB limit."),{code:"WORKSPACE_TOO_LARGE"});
 return document;
}
