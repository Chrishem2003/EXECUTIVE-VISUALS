import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";

const APPROVED_PROJECT_REF="bokxljngydmqrmktofwm";
const url=String(process.env.SUPABASE_STAGING_URL||"").replace(/\/$/,"");
const key=String(process.env.SUPABASE_STAGING_SECRET_KEY||"");
let origin;
try{
 const parsed=new URL(url);
 if(parsed.protocol!=="https:"||parsed.hostname!==APPROVED_PROJECT_REF+".supabase.co"||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error();
 origin=parsed.origin;
}catch{
 throw Object.assign(new Error("Worker heartbeat acceptance is restricted to the approved staging Supabase project."),{code:"STAGING_WORKER_PROJECT_INVALID"});
}
if(!key)throw Object.assign(new Error("Staging Supabase secret key is required."),{code:"STAGING_WORKER_SECRET_MISSING"});

const headers={apikey:key,"content-type":"application/json","content-profile":"executive_visuals",accept:"application/json"};
if(!key.startsWith("sb_secret_"))headers.authorization="Bearer "+key;
const file=fileURLToPath(import.meta.url);
const families=["storage_maintenance"];

async function rpc(name,args){
 const response=await fetch(origin+"/rest/v1/rpc/"+name,{
  method:"POST",headers,body:JSON.stringify(args),redirect:"error"
 });
 const raw=await response.text();
 if(!response.ok)throw Object.assign(new Error("Staging worker heartbeat RPC failed (HTTP "+response.status+")."),{
  code:"STAGING_WORKER_HEARTBEAT_RPC_FAILED"
 });
 if(!raw)return null;
 try{return JSON.parse(raw);}catch{
  throw Object.assign(new Error("Staging worker heartbeat RPC returned invalid JSON."),{code:"STAGING_WORKER_HEARTBEAT_RESPONSE_INVALID"});
 }
}
async function record(workerId,status,lastCycleAt=null){
 return rpc("record_cloud_worker_heartbeat",{
  p_worker_id:workerId,p_worker_families:families,p_status:status,
  p_last_cycle_at:lastCycleAt,p_last_error_code:null
 });
}
async function read(workerId){
 return rpc("read_cloud_worker_heartbeat",{p_worker_id:workerId});
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

if(process.argv[2]==="--child"){
 const workerId=process.argv[3];
 const write=async status=>{
  const result=await record(workerId,status,status==="healthy"?new Date().toISOString():null);
  process.stdout.write(JSON.stringify({workerId,status,result})+"\n");
 };
 await write("starting");
 await write("healthy");
 const timer=setInterval(()=>{
  void write("healthy").catch(()=>{
   process.stderr.write("Worker heartbeat update failed.\n");
   process.exitCode=1;
  });
 },1500);
 process.on("SIGTERM",async()=>{
  clearInterval(timer);
  try{await write("stopped");process.exitCode=0;}catch{process.exit(1);}
 });
}else{
 const launch=workerId=>{
  const child=spawn(process.execPath,[file,"--child",workerId],{stdio:["ignore","pipe","pipe"],env:process.env});
  const lines=createInterface({input:child.stdout});
  const queue=[],waiters=[];
  lines.on("line",line=>{
   let value;try{value=JSON.parse(line);}catch{return;}
   const waiter=waiters.shift();if(waiter)waiter(value);else queue.push(value);
  });
  child.stderr.on("data",()=>process.stderr.write("Worker heartbeat child reported an error.\n"));
  return{
   child,
   next:()=>queue.length?Promise.resolve(queue.shift()):new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(new Error("Worker heartbeat timed out."),{code:"STAGING_WORKER_HEARTBEAT_TIMEOUT"})),15000);
    waiters.push(value=>{clearTimeout(timer);resolve(value);});
   })
  };
 };
 const firstId="staging-crash-test-"+randomUUID();
 const first=launch(firstId);
 let second=null;
 try{
  const firstStarting=await first.next();
  assert.equal(firstStarting.status,"starting");
  const firstHealthy=await first.next();
  assert.equal(firstHealthy.status,"healthy");
  const initial=await read(firstId);
  assert.equal(initial?.status,"healthy");
  const initialHeartbeat=initial.heartbeatAt;
  if(!initialHeartbeat)throw new Error("Initial staging worker heartbeat timestamp is missing.");

  assert.equal(first.child.kill("SIGKILL"),true,"failed to terminate the first worker process");
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error("Killed worker process did not exit.")),10000);
   first.child.once("exit",()=>{clearTimeout(timer);resolve();});
  });
  await delay(2200);
  const afterCrash=await read(firstId);
  assert.equal(afterCrash?.status,"healthy","a killed process must not be able to write a graceful stopped status");
  assert.equal(afterCrash?.heartbeatAt,initialHeartbeat,"heartbeat must stop advancing after forced process termination");

  await record(firstId,"stopped");
  const crashRecordClosed=await read(firstId);
  assert.equal(crashRecordClosed?.status,"stopped");

  const secondId="staging-graceful-test-"+randomUUID();
  second=launch(secondId);
  const secondStarting=await second.next();
  assert.equal(secondStarting.workerId,secondId);
  assert.equal(secondStarting.status,"starting");
  const secondHealthy=await second.next();
  assert.equal(secondHealthy.status,"healthy");
  assert.equal((await read(secondId))?.status,"healthy");

  assert.equal(second.child.kill("SIGTERM"),true,"failed to request graceful worker shutdown");
  const stopped=await second.next();
  assert.equal(stopped.status,"stopped");
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error("Gracefully stopped worker did not exit.")),10000);
   second.child.once("exit",()=>{clearTimeout(timer);resolve();});
  });
  assert.equal((await read(secondId))?.status,"stopped");
  console.log(JSON.stringify({
   result:"passed",approvedProject:APPROVED_PROJECT_REF,
   forcedTerminationDetected:true,heartbeatStoppedAdvancing:true,
   staleTestRecordClosed:true,gracefulShutdownRecorded:true,
   credentialValuesExposed:false
  }));
 }finally{
  if(first.child.exitCode===null&&first.child.signalCode===null)first.child.kill("SIGKILL");
  if(second&&second.child.exitCode===null&&second.child.signalCode===null)second.child.kill("SIGKILL");
 }
}
