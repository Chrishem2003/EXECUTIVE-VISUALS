import {createHash} from "node:crypto";

function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
function stable(value){return JSON.stringify(canonical(value));}
function fail(message,code){throw Object.assign(new Error(message),{code});}

export function createDeliveryManifest({timelineId,timelineRevision,outputAsset,sha256,byteSize,mediaType,profileId=null,deliveryReport=null,renderManifest=null,createdAt=new Date().toISOString()}){
 if(typeof timelineId!=="string"||!timelineId)fail("A timeline ID is required.","DELIVERY_MANIFEST_TIMELINE_REQUIRED");
 const revisionText=typeof timelineRevision==="string"?timelineRevision.trim():"";
 const numericRevisionText=/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(revisionText);
 const validStringRevision=typeof timelineRevision==="string"&&revisionText.length>0&&timelineRevision.length<=128&&(!numericRevisionText||(Number.isSafeInteger(Number(revisionText))&&Number(revisionText)>=1));
 if(!(validStringRevision||(Number.isSafeInteger(timelineRevision)&&timelineRevision>=1)))fail("A valid positive timeline revision is required.","DELIVERY_MANIFEST_REVISION_INVALID");
 if(typeof outputAsset!=="string"||!outputAsset)fail("A published output asset ID is required.","DELIVERY_MANIFEST_ASSET_REQUIRED");
 if(!/^[a-f0-9]{64}$/i.test(String(sha256||"")))fail("A SHA-256 output checksum is required.","DELIVERY_MANIFEST_CHECKSUM_INVALID");
 if(!Number.isSafeInteger(byteSize)||byteSize<1)fail("A positive output byte size is required.","DELIVERY_MANIFEST_SIZE_INVALID");
 if(typeof mediaType!=="string"||!mediaType.includes("/"))fail("A valid media type is required.","DELIVERY_MANIFEST_MEDIA_TYPE_INVALID");
 if(typeof createdAt!=="string"||!Number.isFinite(Date.parse(createdAt)))fail("A valid creation timestamp is required.","DELIVERY_MANIFEST_TIMESTAMP_INVALID");
 const evidence={schemaVersion:1,timelineId,timelineRevision,output:{assetId:outputAsset,sha256:sha256.toLowerCase(),byteSize,mediaType},profileId,deliveryReport:deliveryReport?canonical(deliveryReport):null,renderManifest:renderManifest?canonical(renderManifest):null,createdAt};
 const fingerprint=createHash("sha256").update(stable(evidence)).digest("hex");
 return Object.freeze({...evidence,fingerprint});
}
export function verifyDeliveryManifest(manifest){
 if(!manifest||typeof manifest!=="object"||typeof manifest.fingerprint!=="string")return false;
 const {fingerprint,...evidence}=manifest;
 return /^[a-f0-9]{64}$/i.test(fingerprint)&&createHash("sha256").update(stable(evidence)).digest("hex")===fingerprint;
}
