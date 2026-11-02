const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Revalidate an approved transformation plan against its authoritative jobs
 * row immediately before a remote provider dispatch. This is server-only:
 * the service-role credential and owner identity never come from the job body.
 */
export function createCloudTransformationAuthorization({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,ownerId,projectId,timeoutMs=10000}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function")throw new Error("Cloud transformation authorization requires server-side database access.");
 if(!UUID.test(ownerId||"")||!UUID.test(projectId||""))throw new Error("Cloud transformation authorization requires verified owner and project IDs.");
 const base=new URL(url).origin;
 return async function authorizeExecution({approvalId,pipelineId,stepId,adapterId,capability,requiredBudgetMicros,signal}={}){
  if(signal?.aborted)return{approved:false,reason:"cancelled"};
  if(!UUID.test(approvalId||"")||!Number.isSafeInteger(requiredBudgetMicros)||requiredBudgetMicros<0)return{approved:false,reason:"invalid_request"};
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal?.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const query=new URLSearchParams({select:"id,owner_id,project_id,job_type,status,estimated_cost,approved_by,approved_at",id:"eq."+approvalId,owner_id:"eq."+ownerId,project_id:"eq."+projectId,job_type:"eq.video.transform.plan",limit:"1"});
   // Approval IDs are stored inside estimated_cost, not as job IDs. Query the
   // bounded project set and compare the approval identifier in trusted data.
   query.delete("id");
   const response=await fetchImpl(base+"/rest/v1/jobs?"+query.toString(),{
    method:"GET",headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,accept:"application/json","accept-profile":"executive_visuals"},signal:controller.signal
   });
   if(!response.ok)return{approved:false,reason:"approval_lookup_failed"};
   const rows=await response.json();
   if(!Array.isArray(rows))return{approved:false,reason:"approval_lookup_invalid"};
   const row=rows.find(item=>item?.estimated_cost?.approvalId===approvalId);
   if(!row||row.owner_id!==ownerId||row.project_id!==projectId||row.job_type!=="video.transform.plan"||row.status!=="awaiting_approval"||!row.approved_at||row.approved_by!==ownerId)return{approved:false,reason:"approval_not_active"};
   const record=row.estimated_cost;
   if(record.adapterId!==adapterId||record.capability!==capability||!Number.isSafeInteger(record.approvedBudgetMicros)||record.approvedBudgetMicros<requiredBudgetMicros)return{approved:false,reason:"approval_scope_or_budget_mismatch"};
   return{approved:true,approvalId,adapterId,capability,approvedBudgetMicros:record.approvedBudgetMicros};
  }catch(error){
   if(error?.name==="AbortError")return{approved:false,reason:"authorization_timeout_or_cancelled"};
   return{approved:false,reason:"authorization_unavailable"};
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
 };
}
