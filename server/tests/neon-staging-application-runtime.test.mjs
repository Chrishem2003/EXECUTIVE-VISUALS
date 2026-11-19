import test from "node:test";
import assert from "node:assert/strict";
import {createNeonStagingApprovalDispatch} from "../neon-staging-application-runtime.mjs";

const baseEnv={
  NEON_STAGING_APPLICATION_DISPATCH_ENABLED:"true",
  NEON_STAGING_RUNTIME_ENABLED:"true",
  NEON_STAGING_BRANCH_NAME:"executive-visuals-staging",
  AUTH_MODE:"supabase",
  SUPABASE_URL:"https://auth.example.test",
  SUPABASE_PUBLISHABLE_KEY:"public-test-key",
  NEON_CUSTOMER_CREDITS_PER_USD:"100"
};
function readyRuntime(){
  const state={closed:false,quote:null};
  return {
    state,
    async factory(args){
      state.quote=args.quoteCustomerCredits;
      return {
        backend:"neon-postgres",branch:"executive-visuals-staging",
        async checkReadiness(){return{applicationDispatchReady:true,ready:true};},
        async close(){state.closed=true;},
        videoApprovals:{approvals:{register(){},enqueue(){}}}
      };
    }
  };
}
test("remains inert unless the explicit application dispatch gate is enabled",async()=>{
  const result=await createNeonStagingApprovalDispatch({env:{...baseEnv,NEON_STAGING_APPLICATION_DISPATCH_ENABLED:"false"}});
  assert.equal(result.enabled,false);assert.equal(result.dispatch,null);
});
test("requires isolated branch, existing Supabase identity boundary and an explicit credit policy",async()=>{
  await assert.rejects(createNeonStagingApprovalDispatch({env:{...baseEnv,NEON_STAGING_BRANCH_NAME:"main"}}),/explicitly enabled/);
  await assert.rejects(createNeonStagingApprovalDispatch({env:{...baseEnv,AUTH_MODE:"local"}}),/Supabase authentication/);
  await assert.rejects(createNeonStagingApprovalDispatch({env:{...baseEnv,NEON_CUSTOMER_CREDITS_PER_USD:""}}),/positive integer/);
  await assert.rejects(createNeonStagingApprovalDispatch({env:{...baseEnv,NEON_CUSTOMER_CREDITS_PER_USD:"1.5"}}),/positive integer/);
});
test("builds a deterministic server-side USD credit quote using integer arithmetic",async()=>{
  const runtime=readyRuntime();
  const result=await createNeonStagingApprovalDispatch({env:baseEnv,db:{prepare(){}},canWriteProject:()=>true,createRuntime:runtime.factory});
  assert.equal(result.enabled,true);
  assert.equal(runtime.state.quote({currency:"USD",amountMicros:1_250_000}),125);
  assert.equal(runtime.state.quote({currency:"USD",amountMicros:1}),1);
  assert.throws(()=>runtime.state.quote({currency:"EUR",amountMicros:1_000_000}),/requires a verified USD quote/);
  assert.throws(()=>runtime.state.quote({currency:"USD",amountMicros:1_000_000_000_000}),/exceeds/);
  await result.close();assert.equal(runtime.state.closed,true);
});
test("fails closed and closes the pool if Neon schema readiness is incomplete",async()=>{
  const runtime=readyRuntime();
  await assert.rejects(createNeonStagingApprovalDispatch({
    env:baseEnv,db:{prepare(){}},canWriteProject:()=>true,
    createRuntime:async()=>({...await runtime.factory({}),async checkReadiness(){return{applicationDispatchReady:false};}})
  }),/not ready/);
  assert.equal(runtime.state.closed,true);
});
test("rejects a runtime whose branch identity does not match staging",async()=>{
  const runtime=readyRuntime();
  await assert.rejects(createNeonStagingApprovalDispatch({
    env:baseEnv,db:{prepare(){}},canWriteProject:()=>true,
    createRuntime:async()=>({...await runtime.factory({}),branch:"main"})
  }),/identity/);
  assert.equal(runtime.state.closed,true);
});
