const SHA256=/^[a-f0-9]{64}$/i;
const fail=(message,code)=>Object.assign(new Error(message),{code});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Owner/project-scoped durable checkpoint repository backed by the local SQLite database. */
export function createSqliteVideoPipelineCheckpointStore({db,ownerId,projectId=null}={}){
 if(!db||typeof db.prepare!=="function")throw new Error("Video pipeline checkpoint store requires the application database.");
 if(typeof ownerId!=="string"||!ownerId.trim())throw new Error("Video pipeline checkpoint store requires an authenticated owner ID.");
 if(projectId!==null&&(typeof projectId!=="string"||!projectId.trim()))throw new Error("Video pipeline project ID is invalid.");
 const getStatement=db.prepare("SELECT pipeline_id,step_id,status,input_asset_id,input_sha256,idempotency_key,output_json,approval_id,created_at FROM video_pipeline_checkpoints WHERE owner_id=? AND ((project_id IS NULL AND ? IS NULL) OR project_id=?) AND pipeline_id=? AND step_id=?");
 function read(pipelineId,stepId){
  const row=getStatement.get(ownerId,projectId,projectId,pipelineId,stepId);
  if(!row)return null;
  let outputAsset;
  try{outputAsset=JSON.parse(row.output_json);}catch{throw fail("Stored video pipeline checkpoint is corrupt.","VIDEO_PIPELINE_CHECKPOINT_CORRUPT");}
  return {pipelineId:row.pipeline_id,stepId:row.step_id,status:row.status,inputAssetId:row.input_asset_id,inputSha256:row.input_sha256,idempotencyKey:row.idempotency_key,outputAsset,approvalId:row.approval_id,createdAt:row.created_at};
 }
 return Object.freeze({
  async get(pipelineId,stepId){return read(pipelineId,stepId);},
  async save(record){
   if(!record||typeof record!=="object"||Array.isArray(record)||typeof record.pipelineId!=="string"||!record.pipelineId.trim()||typeof record.stepId!=="string"||!record.stepId.trim()||record.status!=="succeeded"||typeof record.inputAssetId!=="string"||!record.inputAssetId.trim()||!SHA256.test(record.inputSha256||"")||!SHA256.test(record.idempotencyKey||"")||!record.outputAsset||typeof record.outputAsset!=="object"||Array.isArray(record.outputAsset))
    throw fail("Video pipeline checkpoint record is invalid.","VIDEO_PIPELINE_CHECKPOINT_INVALID");
   const outputJson=JSON.stringify(record.outputAsset);
   if(!outputJson||outputJson.length>32000)throw fail("Video pipeline checkpoint output exceeds the 32 KB limit.","VIDEO_PIPELINE_CHECKPOINT_INVALID");
   db.prepare("INSERT OR IGNORE INTO video_pipeline_checkpoints(owner_id,project_id,pipeline_id,step_id,status,input_asset_id,input_sha256,idempotency_key,output_json,approval_id) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(ownerId,projectId,record.pipelineId,record.stepId,record.status,record.inputAssetId,record.inputSha256.toLowerCase(),record.idempotencyKey,outputJson,record.approvalId||null);
   const stored=read(record.pipelineId,record.stepId);
   if(!stored||stored.idempotencyKey!==record.idempotencyKey||stored.inputAssetId!==record.inputAssetId||stored.inputSha256!==record.inputSha256.toLowerCase()||!same(stored.outputAsset,record.outputAsset))
    throw fail("A different checkpoint already exists for this pipeline step.","VIDEO_PIPELINE_CHECKPOINT_CONFLICT");
   return stored;
  }
 });
}
