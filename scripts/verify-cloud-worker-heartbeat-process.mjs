import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

const url=String(process.env.SUPABASE_URL||"").replace(/\/$/,"");
const EXPECTED_STAGING_PROJECT_REF="bokxljngydmqrmktofwm";
if(url&&new URL(url).hostname!==`\${EXPECTED_STAGING_PROJECT_REF}.supabase.co`)throw new Error("Refusing worker test against a non-approved Supabase staging project.");
const key=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||"";
if(!url||!key)throw new Error("Staging SUPABASE_URL and service-role/secret key are required.");
const file=fileURLToPath(import.meta.url);
const families=["storage_maintenance"];
async function record(workerId,status,lastCycleAt=null){
 const headers={apikey:key,"content-type":"application/json","content-profile":"executive_visuals",accept:"application/json"};
 if(!key.startsWith("sb_secret_"))headers.authorization="Bearer "+key;
 const response=await fetch(url+"/rest/v1/rpc/record_cloud_worker_heartbeat",{method:"POST",headers,body:JSON.stringify({
  p_worker_id:workerId,p_worker_families:families,p_status:status,p_last_cycle_at:lastCycleAt,p_last_error_code:null
 })});
 const raw=await response.text();
 if(!response.ok)throw new Error("Heartbeat RPC failed with HTTP "+response.status+": "+raw.slice(0,250));
 return raw?JSON.parse(raw):null;
}
if(process.argv[2]==="--child"){
 const workerId=process.argv[3];
 const write=async status=>{const result=await record(workerId,status,status==="healthy"?new Date().toISOString():null);process.stdout.write(JSON.stringify({workerId,status,result})+"\n");};
 await write("starting");await write("healthy");
 const timer=setInterval(()=>{void write("healthy").catch(error=>{process.stderr.write(String(error.message||error));process.exitCode=1;});},1500);
 process.on("SIGTERM",async()=>{clearInterval(timer);try{await write("stopped");process.exitCode=0;}catch{process.exitCode=1;}});
}else{
 const launch=workerId=>{
  const child=spawn(process.execPath,[file,"--child",workerId],{stdio:["ignore","pipe","pipe"],env:process.env});
  const lines=createInterface({input:child.stdout});
  const queue=[];const waiters=[];
  lines.on("line",line=>{let value;try{value=JSON.parse(line);}catch{return;}const waiter=waiters.shift();if(waiter)waiter(value);else queue.push(value);});
  child.stderr.on("data",chunk=>process.stderr.write(chunk));
  return {child,next:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Worker heartbeat timed out.")),15000);waiters.push(value=>{clearTimeout(timer);resolve(value);});})};
 };
 const firstId="staging-restart-before-"+randomUUID();
 const first=launch(firstId);
 const firstStarting=await first.next();assert.equal(firstStarting.status,"starting");
 const firstHealthy=await first.next();assert.equal(firstHealthy.status,"healthy");
 const killed=first.child.kill("SIGKILL");assert.equal(killed,true,"failed to terminate first worker process");
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Killed worker process did not exit.")),10000);first.child.once("exit",()=>{clearTimeout(timer);resolve();});});
 const secondId="staging-restart-after-"+randomUUID();
 const second=launch(secondId);
 const secondStarting=await second.next();assert.equal(secondStarting.workerId,secondId);assert.equal(secondStarting.status,"starting");
 const secondHealthy=await second.next();assert.equal(secondHealthy.status,"healthy");
 second.child.kill("SIGTERM");
 const stopped=await second.next();assert.equal(stopped.status,"stopped");
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Restarted worker did not exit cleanly.")),10000);second.child.once("exit",()=>{clearTimeout(timer);resolve();});});
 console.log(JSON.stringify({result:"passed",forcedTermination:true,restartWorkerIdChanged:firstId!==secondId,secondProcessHeartbeat:true,gracefulStop:true}));
}
