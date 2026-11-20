import test from "node:test";
import assert from "node:assert/strict";
import { createCloudCustomerCreditLedger } from "../cloud-customer-credit-ledger.mjs";

test("customer credit settlement sends modern Supabase secret in apikey without Bearer",async()=>{
 const calls=[];
 const ledger=createCloudCustomerCreditLedger({
  url:"https://example.supabase.co",
  serviceRoleKey:"sb_secret_modern",
  fetchImpl:async(url,options)=>{
   calls.push({url,options});
   return new Response(JSON.stringify([{balance:90,adjustment:-10,replayed:false}]),{status:200});
  }
 });
 const result=await ledger.settleJob({
  jobId:"video-job-1",ownerId:"owner-1",provider:"google",actualCredits:10,
  evidence:{provider:"google",evidenceType:"provider_usage_reconciliation",evidenceId:"v1_abcdef123456",evidenceReference:"google-interaction-usage:v1_abcdef123456"}
 });
 assert.deepEqual(result,{balance:90,adjustment:-10,replayed:false});
 assert.equal(calls[0].options.headers.apikey,"sb_secret_modern");
 assert.equal("authorization" in calls[0].options.headers,false);
});

test("customer credit settlement preserves legacy JWT Bearer compatibility",async()=>{
 let headers;
 const ledger=createCloudCustomerCreditLedger({
  url:"https://example.supabase.co",
  serviceRoleKey:"legacy-service-role-jwt",
  fetchImpl:async(_url,options)=>{
   headers=options.headers;
   return new Response(JSON.stringify([{balance:90,adjustment:-10,replayed:false}]),{status:200});
  }
 });
 await ledger.settleJob({
  jobId:"video-job-1",ownerId:"owner-1",provider:"google",actualCredits:10,
  evidence:{provider:"google",evidenceType:"provider_usage_reconciliation",evidenceId:"v1_abcdef123456",evidenceReference:"google-interaction-usage:v1_abcdef123456"}
 });
 assert.equal(headers.apikey,"legacy-service-role-jwt");
 assert.equal(headers.authorization,"Bearer legacy-service-role-jwt");
});
