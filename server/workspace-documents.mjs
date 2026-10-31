const text=(value,max)=>String(value??"").slice(0,max);
const records=(value,limit,fields)=>Array.isArray(value)?value.slice(0,limit).filter(item=>item&&typeof item==="object"&&!Array.isArray(item)).map(item=>Object.fromEntries(fields.map(([key,max])=>[key,text(item[key],max)]))):[];
export function sanitizeCreativeWorkspaceDocument(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw Object.assign(new Error("Workspace document must be a JSON object."),{code:"INVALID_WORKSPACE_DOCUMENT"});
 const document={
  schemaVersion:1,
  projects:records(input.projects,100,[["id",80],["name",160],["brief",10000],["audience",2000],["style",200],["created",40]]),
  tasks:records(input.tasks,500,[["id",80],["name",200],["category",120],["status",40],["created",40],["detail",4000]]),
  shots:records(input.shots,500,[["id",80],["scene",200],["action",4000],["camera",300],["lens",120],["movement",300],["lighting",500]]).map((item,index)=>({...item,duration:Math.max(0,Math.min(3600,Number(input.shots[index]?.duration)||0))})),
  characters:records(input.characters,200,[["id",80],["name",160],["description",6000],["voice",160]]).map((item,index)=>({...item,consent:input.characters[index]?.consent===true})),
  prompt:text(input.prompt,20000),
  plan:text(input.plan,50000),
  script:text(input.script,50000),
  variants:Array.isArray(input.variants)?input.variants.slice(0,100).map(value=>text(value,4000)):[]
 };
 if(Buffer.byteLength(JSON.stringify(document),"utf8")>2*1024*1024)throw Object.assign(new Error("Workspace document exceeds the 2 MiB limit."),{code:"WORKSPACE_TOO_LARGE"});
 return document;
}
