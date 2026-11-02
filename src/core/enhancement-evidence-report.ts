export interface EnhancementReportAsset {
  id:string;name?:string;mediaType?:string;size?:number;sha256?:string;derivativeOf?:string|null;
  metadata?:{processing?:Record<string,unknown>};
}
export interface EnhancementReportLineage {
  ancestors:Array<{id:string;name?:string;mediaType?:string;sha256?:string;missing?:boolean;cycle?:boolean}>;
  descendants:Array<{id:string;name?:string;mediaType?:string;sha256?:string;missing?:boolean;cycle?:boolean}>;
  truncated?:boolean;collectionTruncated?:boolean;nodeCount?:number;
}
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/i.test(value);
const text=(value:unknown,max=240)=>typeof value==="string"?value.slice(0,max):null;
const finite=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:null;

/** Build a portable, URL-free evidence snapshot. It deliberately does not infer perceptual quality. */
export function buildEnhancementEvidenceReport(asset:EnhancementReportAsset,lineage:EnhancementReportLineage|null,generatedAt=new Date().toISOString()){
 if(!asset||typeof asset.id!=="string"||!asset.id)throw new TypeError("A valid asset is required.");
 if(typeof generatedAt!=="string"||!Number.isFinite(Date.parse(generatedAt)))throw new TypeError("A valid report timestamp is required.");
 const p=asset.metadata?.processing||{};
 const hasProcessing=Object.keys(p).length>0;
 const sourceHash=p.inputSha256??p.sourceSha256??asset.metadata?.processing?.sourceSha256;
 const outputHash=p.outputSha256;
 const checks=[
  {key:"processing_record",status:hasProcessing?"verified":"missing"},
  {key:"source_checksum",status:hash(sourceHash)?"verified":"missing_or_invalid"},
  {key:"output_checksum",status:hash(outputHash)&&hash(asset.sha256)&&outputHash.toLowerCase()===asset.sha256.toLowerCase()?"verified":"missing_or_mismatched"},
  {key:"dimensions",status:p.dimensionsVerified===true?"verified":"not_verified"},
  {key:"decoder",status:p.decoderVerified===true?"verified":"not_verified"},
  {key:"independent_review",status:p.qualityReview==="reviewed_pass"?"reviewed_pass":p.qualityReview==="reviewed_fail"?"reviewed_fail":"pending_or_missing"}
 ];
 const lineageNode=(node:EnhancementReportLineage["ancestors"][number])=>({id:text(node.id,200),name:text(node.name),mediaType:text(node.mediaType,120),sha256:hash(node.sha256)?node.sha256:null,missing:node.missing===true,cycle:node.cycle===true});
 return {
  schema:"executive-visuals.enhancement-evidence.v1",generatedAt,
  asset:{id:asset.id,name:text(asset.name),mediaType:text(asset.mediaType,120),size:finite(asset.size),sha256:hash(asset.sha256)?asset.sha256:null,derivativeOf:text(asset.derivativeOf,200)},
  processing:{engine:text(p.engine,120),method:text(p.method,120),model:text(p.model,160),modelVersion:text(p.modelVersion,240),scale:finite(p.scale),tile:finite(p.tile),durationMs:finite(p.durationMs),sourceWidth:finite(p.sourceWidth),sourceHeight:finite(p.sourceHeight),width:finite(p.width),height:finite(p.height),binarySha256:hash(p.binarySha256)?p.binarySha256:null,modelFilesSha256:hash(p.modelFilesSha256)?p.modelFilesSha256:null},
  checks,
  lineage:lineage?{ancestors:lineage.ancestors.map(lineageNode),descendants:lineage.descendants.map(lineageNode),truncated:lineage.truncated===true,collectionTruncated:lineage.collectionTruncated===true,nodeCount:finite(lineage.nodeCount)}:null,
  interpretation:{technicalEvidenceOnly:true,perceptualQualityAssessed:false,humanReviewRequired:true,privatePreviewUrlsIncluded:false}
 };
}
