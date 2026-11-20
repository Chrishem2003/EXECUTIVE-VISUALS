import { createNeonStagingRuntime } from "./neon-staging-runtime.mjs";
import { createNeonStagingApplicationDispatch } from "./neon-staging-application-dispatch.mjs";
import { createNeonCustomerCreditQuotePolicy } from "./neon-customer-credit-policy.mjs";

/**
 * Explicitly gated composition for the existing authenticated approval route.
 * Private storage and the approval/financial ledger are supplied by the
 * application host. Provider execution runs in a separate gated background
 * worker; this API process never substitutes the active Supabase worker.
 */
export async function createNeonStagingApprovalDispatch({
  env=process.env,db,canWriteProject,audit,createRuntime=createNeonStagingRuntime,
  runtimeOptions={}
}={}){
  if(env.NEON_STAGING_APPLICATION_DISPATCH_ENABLED!=="true"){
    return Object.freeze({enabled:false,dispatch:null,runtime:null,close:async()=>{}});
  }
  if(env.NEON_STAGING_RUNTIME_ENABLED!=="true"||
     env.NEON_STAGING_BRANCH_NAME!=="executive-visuals-staging"){
    throw new Error("Neon application dispatch requires the explicitly enabled executive-visuals-staging runtime.");
  }
  if(env.AUTH_MODE!=="supabase"||!env.SUPABASE_URL||!env.SUPABASE_PUBLISHABLE_KEY){
    throw new Error("Neon application dispatch requires the existing verified Supabase authentication boundary.");
  }
  if(!db||typeof canWriteProject!=="function")throw new Error("Neon application dispatch requires the application database and project authorization.");
  if(!runtimeOptions||typeof runtimeOptions!=="object"||Array.isArray(runtimeOptions)){
    throw new Error("Neon application runtime options must be a plain configuration object.");
  }
  const quoteCustomerCredits=createNeonCustomerCreditQuotePolicy({env});
  let runtime=null;
  try{
    runtime=await createRuntime({
      ...runtimeOptions,
      env,
      quoteCustomerCredits,
      enableVideoApprovals: true
    });
    if(runtime?.backend!=="neon-postgres"||runtime?.branch!=="executive-visuals-staging"){
      throw new Error("Neon runtime identity does not match the approved staging branch.");
    }
    const readiness=await runtime.checkReadiness();
    if(readiness?.applicationDispatchReady!==true){
      throw new Error("Neon staging approval dispatch is not ready; required migrations, financial controls, approval tables and private storage must pass readiness.");
    }
    const dispatch=createNeonStagingApplicationDispatch({db,runtime,canWriteProject,audit});
    return Object.freeze({enabled:true,dispatch,runtime,readiness,close:()=>runtime.close()});
  }catch(error){
    if(runtime&&typeof runtime.close==="function")try{await runtime.close();}catch{}
    throw error;
  }
}
