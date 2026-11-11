const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const allowedCreate=new Set(["projectId","assetId","timelineId","timelineRevision","frameNumber","durationFrames","timecodeSeconds","body","decision","visibility","annotation","requestId"]);
const allowedPatch=new Set(["body","decision","status","visibility","annotation"]);

function boundedText(value,label,min,max){
 if(typeof value!=="string")fail("REVIEW_INVALID",label+" must be text.");
 const result=value.trim();
 if(result.length<min||result.length>max)fail("REVIEW_INVALID",label+" length is outside its allowed range.");
 return result;
}
function optionalUuid(value,label){
 if(value===undefined||value===null||value==="")return null;
 if(typeof value!=="string"||!UUID.test(value))fail("REVIEW_INVALID",label+" must be a UUID.");
 return value;
}
function normalizeAnnotation(value){
 if(value===undefined||value===null)return null;
 if(!object(value)||Object.keys(value).some(key=>key!=="version"&&key!=="shapes"))fail("REVIEW_ANNOTATION_INVALID","Annotation must contain only version and shapes.");
 if(value.version!==1||!Array.isArray(value.shapes)||value.shapes.length<1||value.shapes.length>32)fail("REVIEW_ANNOTATION_INVALID","Annotation must be version 1 and contain 1 to 32 shapes.");
 const shapes=value.shapes.map((shape,index)=>{
  if(!object(shape)||Object.keys(shape).some(key=>!["type","points","color","width"].includes(key)))fail("REVIEW_ANNOTATION_INVALID","Annotation shape "+index+" contains unsupported fields.");
  if(!["arrow","line","rectangle","ellipse","freehand"].includes(shape.type))fail("REVIEW_ANNOTATION_INVALID","Annotation shape type is not supported.");
  if(!Array.isArray(shape.points)||shape.points.length<(shape.type==="rectangle"||shape.type==="ellipse"?2:2)||shape.points.length>256)fail("REVIEW_ANNOTATION_INVALID","Annotation shape points are invalid.");
  const points=shape.points.map(point=>{
   if(!object(point)||typeof point.x!=="number"||typeof point.y!=="number"||!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<0||point.x>1||point.y<0||point.y>1)fail("REVIEW_ANNOTATION_INVALID","Annotation coordinates must be normalized between 0 and 1.");
   return{x:Number(point.x.toFixed(5)),y:Number(point.y.toFixed(5))};
  });
  const color=shape.color??"#ffcc00";
  if(typeof color!=="string"||!/^#[0-9a-f]{6}$/i.test(color))fail("REVIEW_ANNOTATION_INVALID","Annotation colors must be six-digit hex values.");
  const width=shape.width??3;
  if(typeof width!=="number"||!Number.isFinite(width)||width<1||width>16)fail("REVIEW_ANNOTATION_INVALID","Annotation line width must be between 1 and 16.");
  return{type:shape.type,points,color,width};
 });
 return{version:1,shapes};
}

export function normalizeReviewCreate(input){
 if(!object(input)||Object.keys(input).some(key=>!allowedCreate.has(key)))fail("REVIEW_INVALID","Review contains unsupported fields.");
 const projectId=optionalUuid(input.projectId,"Project ID");
 if(!projectId)fail("REVIEW_INVALID","Project ID is required.");
 const assetId=optionalUuid(input.assetId,"Asset ID");
 const timelineId=optionalUuid(input.timelineId,"Timeline ID");
 const timelineRevision=input.timelineRevision===undefined||input.timelineRevision===null?null:input.timelineRevision;
 const frameNumber=input.frameNumber===undefined||input.frameNumber===null?null:input.frameNumber;
 const durationFrames=input.durationFrames===undefined||input.durationFrames===null?null:input.durationFrames;
 const timecodeSeconds=input.timecodeSeconds===undefined||input.timecodeSeconds===null?null:input.timecodeSeconds;
 if(timelineRevision!==null&&(!Number.isSafeInteger(timelineRevision)||timelineRevision<1))fail("REVIEW_INVALID","Timeline revision must be a positive integer.");
 if(frameNumber!==null&&(!Number.isSafeInteger(frameNumber)||frameNumber<0))fail("REVIEW_INVALID","Frame number must be a non-negative safe integer.");
 if(durationFrames!==null&&(!Number.isSafeInteger(durationFrames)||durationFrames<1||durationFrames>90000))fail("REVIEW_INVALID","Frame range duration must be between 1 and 90,000 frames.");
 if(timecodeSeconds!==null&&(typeof timecodeSeconds!=="number"||!Number.isFinite(timecodeSeconds)||timecodeSeconds<0||timecodeSeconds>86400))fail("REVIEW_INVALID","Timecode must be between 0 and 24 hours.");
 if((timelineRevision!==null)!==(timelineId!==null))fail("REVIEW_INVALID","Timeline ID and revision must be supplied together.");
 if((timelineRevision!==null||frameNumber!==null||durationFrames!==null)&&!assetId)fail("REVIEW_INVALID","Frame anchors require an asset ID.");
 if(durationFrames!==null&&frameNumber===null)fail("REVIEW_INVALID","Frame range duration requires a starting frame.");
 if(timelineId!==null&&frameNumber===null)fail("REVIEW_INVALID","Timeline revision anchors require a frame number.");
 const annotation=normalizeAnnotation(input.annotation);
 if(annotation&&frameNumber===null)fail("REVIEW_ANNOTATION_INVALID","Drawing annotations require a frame-anchored comment.");
 const decision=input.decision??"comment";
 if(!["comment","approve","request_changes"].includes(decision))fail("REVIEW_INVALID","Review decision is unsupported.");
 const visibility=input.visibility??"project";
 if(!["project","internal"].includes(visibility))fail("REVIEW_INVALID","Review visibility must be project or internal.");
 const requestId=input.requestId===undefined||input.requestId===null?null:boundedText(input.requestId,"Request ID",8,128);
 return{projectId,assetId,timelineId,timelineRevision,frameNumber,durationFrames,timecodeSeconds,body:boundedText(input.body,"Review comment",1,10000),decision,visibility,annotation,requestId};
}
export function normalizeReviewPatch(input){
 if(!object(input)||Object.keys(input).length===0||Object.keys(input).some(key=>!allowedPatch.has(key)))fail("REVIEW_INVALID","Review update contains unsupported fields.");
 const patch={};
 if("body" in input)patch.body=boundedText(input.body,"Review comment",1,10000);
 if("decision" in input){if(!["comment","approve","request_changes"].includes(input.decision))fail("REVIEW_INVALID","Review decision is unsupported.");patch.decision=input.decision;}
 if("status" in input){if(!["open","resolved","dismissed"].includes(input.status))fail("REVIEW_INVALID","Review status is unsupported.");patch.status=input.status;}
 if("visibility" in input){if(!["project","internal"].includes(input.visibility))fail("REVIEW_INVALID","Review visibility must be project or internal.");patch.visibility=input.visibility;}
 if("annotation" in input)patch.annotation=normalizeAnnotation(input.annotation);
 return patch;
}
