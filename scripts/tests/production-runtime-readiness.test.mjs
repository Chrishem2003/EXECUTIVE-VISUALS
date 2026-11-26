import test from "node:test";
import assert from "node:assert/strict";
import {assessRuntimeReadiness} from "../verify-production-runtime-readiness.mjs";

test("current production health is not runtime-ready despite HTTP liveness status",()=>{
 const health={status:"ok",database:"sqlite",storage:"local-disk",persistence:{dataDirectory:"unverified",durableAcrossDeploys:false},authMode:"supabase",authSession:{configurationReady:true},cloudMedia:{enabled:false,ready:false,storage:"disabled"},billing:{enabled:false,providerKeyConfigured:false},cloudVideoWorker:{enabled:false,runtimeMode:"separate-process",remoteExecutionGates:false,providerCredentialConfigured:false,outputHostAllowlistConfigured:false}};
 const result=assessRuntimeReadiness(health);
 assert.equal(result.runtimeReady,false);
 assert.deepEqual(result.blockers,["postgres_database","durable_storage","private_cloud_media","dedicated_worker","provider_execution_gate","payment_provider_configuration"]);
 assert.ok(result.manualEvidenceRequired.includes("encrypted_backup_and_isolated_restore"));
});

test("all runtime gates pass only when the expected hosted services are configured",()=>{
 const health={status:"ok",database:"postgres",storage:"supabase",persistence:{durableAcrossDeploys:true},authMode:"supabase",authSession:{configurationReady:true},cloudMedia:{enabled:true,ready:true,storage:"supabase"},billing:{enabled:true,providerKeyConfigured:true},cloudVideoWorker:{enabled:true,runtimeMode:"separate-process",remoteExecutionGates:true,providerCredentialConfigured:true,outputHostAllowlistConfigured:true}};
 const result=assessRuntimeReadiness(health);
 assert.equal(result.runtimeReady,true);
 assert.deepEqual(result.blockers,[]);
 assert.ok(result.manualEvidenceRequired.length>0,"runtime readiness must not imply paid-launch acceptance");
});
