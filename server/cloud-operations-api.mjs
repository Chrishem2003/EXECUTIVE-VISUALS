const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createCloudOperationsApi({queue,adminEmails=[]}={}){
 if(!queue||typeof queue.listJobDiagnostics!=="function"||typeof queue.listWorkerHealth!=="function"||typeof queue.listAssetCleanupDiagnostics!=="function")throw new Error("Cloud operations requires the trusted cloud queue diagnostics adapter.");
 if(!Array.isArray(adminEmails))throw new Error("Cloud operations administrator allowlist must be an array.");
 const admins=new Set(adminEmails.map(value=>String(value||"").trim().toLowerCase()).filter(value=>EMAIL.test(value)));
 if(admins.size===0)throw new Error("Cloud operations requires at least one valid CLOUD_OPERATIONS_ADMIN_EMAILS entry.");
 return Object.freeze({
  async handle({method,path,user,query={}}={}){
   if(path!=="/api/admin/cloud/operations"||method!=="GET")return null;
   if(!user||typeof user.id!=="string"||!user.id)return {status:401,body:{error:{code:"AUTH_REQUIRED",message:"A verified account identity is required."}}};
   if(user.emailVerified!==true)return {status:403,body:{error:{code:"CLOUD_OPERATIONS_VERIFIED_EMAIL_REQUIRED",message:"A verified email address is required for cloud operations."}}};
   const email=String(user.email||"").trim().toLowerCase();
   if(!admins.has(email))return {status:403,body:{error:{code:"CLOUD_OPERATIONS_ADMIN_REQUIRED",message:"An explicitly allowlisted cloud operations administrator is required."}}};
   const limit=query.limit===undefined?100:Number(query.limit);
   const queueStaleAfterSeconds=query.queueStaleAfterSeconds===undefined?900:Number(query.queueStaleAfterSeconds);
   const leaseStaleAfterSeconds=query.leaseStaleAfterSeconds===undefined?180:Number(query.leaseStaleAfterSeconds);
   const workerStaleAfterSeconds=query.workerStaleAfterSeconds===undefined?180:Number(query.workerStaleAfterSeconds);
   if(!Number.isInteger(limit)||limit<1||limit>200
     ||!Number.isInteger(queueStaleAfterSeconds)||queueStaleAfterSeconds<60||queueStaleAfterSeconds>86400
     ||!Number.isInteger(leaseStaleAfterSeconds)||leaseStaleAfterSeconds<30||leaseStaleAfterSeconds>3600
     ||!Number.isInteger(workerStaleAfterSeconds)||workerStaleAfterSeconds<30||workerStaleAfterSeconds>3600){
    return {status:400,body:{error:{code:"CLOUD_OPERATIONS_INVALID_QUERY",message:"Cloud operations query bounds are invalid."}}};
   }
   try{
    const [jobs,workers,assetCleanup]=await Promise.all([
     queue.listJobDiagnostics({limit,queueStaleAfterSeconds,leaseStaleAfterSeconds}),
     queue.listWorkerHealth({limit,staleAfterSeconds:workerStaleAfterSeconds}),
     queue.listAssetCleanupDiagnostics()
    ]);
    return {status:200,body:{generatedAt:new Date().toISOString(),jobs,workers,assetCleanup}};
   }catch(error){
    return {status:503,body:{error:{code:"CLOUD_OPERATIONS_UNAVAILABLE",message:"Cloud operations diagnostics are temporarily unavailable."}}};
   }
  }
 });
}
