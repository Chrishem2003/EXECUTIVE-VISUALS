export type CloudAssetProjectOption={id:string;name:string};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Keep cloud-library uploads attached to a real, selectable cloud project. */
export function selectCloudAssetProject(currentId:string,projects:readonly CloudAssetProjectOption[]):string{
 const valid=projects.filter(project=>project&&typeof project.id==="string"&&UUID.test(project.id)&&typeof project.name==="string");
 if(valid.some(project=>project.id===currentId))return currentId;
 return valid[0]?.id||"";
}

/** Returns a project-scoped asset query; null prevents accidental owner-level uploads/listing. */
export function cloudAssetProjectQuery(projectId:string,limit=25):string|null{
 if(typeof projectId!=="string"||!UUID.test(projectId)||!Number.isInteger(limit)||limit<1||limit>100)return null;
 return "?projectId="+encodeURIComponent(projectId)+"&limit="+limit;
}
