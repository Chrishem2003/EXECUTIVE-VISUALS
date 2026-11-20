import { createNeonStagingRuntime } from "./neon-staging-runtime.mjs";
import { createNeonStagingApplicationDispatch } from "./neon-staging-application-dispatch.mjs";

function parseCreditRate(value){
  const text=String(value??"").trim();
  if(!/^\d+$/.test(text))throw new Error("NEON_CUSTOMER_CREDITS_PER_USD must be an explicitly configured positive integer.");
  const rate=Number(text);
  if(!Number.isSafeInteger(rate)||rate<1||rate>1_000_000)throw new Error("NEON_CUSTOMER_CREDITS_PER_USD must be between 1 and 1,000,000.");
  return BigInt(rate);
}

function quoteUsdCredits({currency,amountMicros},rate){
  if(currency!=="USD"||!Number.isSafeInteger(amountMicros)||amountMicros<1){
    const error=new Error("Neon staging customer-credit policy currently requires a verified USD quote.");
    error.code="VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
    throw error;
  }
  const amount=BigInt(amountMicros);
  const credits=(amount*rate+999_999n)/1_000_000n;
  if(credits<1n||credits>100_000_000n){
    const error=new Error("The approved production exceeds the configured customer-credit reservation bounds.");
    error.code="VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID";
    throw error;
  }
  return Number(credits);
}

/**
 * Explicitly gated composition for the existing authenticated approval route.
 * Worker adapters, owner/project authorization and private storage are supplied
 * by the application host; this module never invents credentials or silently
 * substitutes the active Supabase worker for the isolated Neon worker.
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
  const rate=parseCreditRate(env.NEON_CUSTOMER_CREDITS_PER_USD);
  let runtime=null;
  try{
    runtime=await createRuntime({
      ...runtimeOptions,
      env,
      quoteCustomerCredits:({currency,amountMicros})=>quoteUsdCredits({currency,amountMicros},rate)
    });
    if(runtime?.backend!=="neon-postgres"||runtime?.branch!=="executive-visuals-staging"){
      throw new Error("Neon runtime identity does not match the approved staging branch.");
    }
    const readiness=await runtime.checkReadiness();
    if(readiness?.applicationDispatchReady!==true){
      throw new Error("Neon staging approval dispatch is not ready; required migrations, financial controls, approval tables, worker authorization and private storage must pass readiness.");
    }
    const dispatch=createNeonStagingApplicationDispatch({db,runtime,canWriteProject,audit});
    return Object.freeze({enabled:true,dispatch,runtime,readiness,close:()=>runtime.close()});
  }catch(error){
    if(runtime&&typeof runtime.close==="function")try{await runtime.close();}catch{}
    throw error;
  }
}
