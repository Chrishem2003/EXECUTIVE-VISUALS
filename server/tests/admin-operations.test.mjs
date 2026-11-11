import test from "node:test";
import assert from "node:assert/strict";
import {isPlatformAdministrator,getAdminOperationsOverview,listAdminOperationUsers,listAdminOperationJobs,listAdminOperationAudit} from "../admin-operations.mjs";
function fakeDb(){
 const calls=[];
 return {calls,prepare(sql){return {get(...args){calls.push({sql,args});if(sql.includes("SELECT (SELECT COUNT(*)"))return {users:3,projects:4,assets:5,jobs:6};if(sql.includes("SUM(estimated_cost_micros)"))return {operations:7,estimatedCostMicros:890000};throw new Error("Unexpected get query");},all(...args){calls.push({sql,args});if(sql.includes("GROUP BY status"))return [{status:"queued",count:2},{status:"failed",count:1}];if(sql.includes("FROM users u"))return [{id:"u1",email:"a@example.com",auth_source:"supabase",created_at:"2026-11-01",projects:2,jobs:3,usage30d:4}];if(sql.includes("FROM jobs j"))return [{id:"j1",email:"a@example.com",job_type:"video.generate",status:"queued",progress:0,attempt_count:1,created_at:"2026-11-01",updated_at:"2026-11-01",completed_at:null}];if(sql.includes("FROM audit_events a"))return [{id:1,owner_id:"u1",email:"a@example.com",event_type:"project.created",subject_type:"project",subject_id:"p1",created_at:"2026-11-01"}];throw new Error("Unexpected all query");}};}};
}
test("platform administrator access requires an explicit case-insensitive allowlist",()=>{
 assert.equal(isPlatformAdministrator({email:"ADMIN@example.com"},{ADMIN_EMAILS:"admin@example.com"}),true);
 assert.equal(isPlatformAdministrator({email:"admin@example.com"},{ADMIN_EMAILS:""}),false);
 assert.equal(isPlatformAdministrator({email:"other@example.com"},{ADMIN_EMAILS:"admin@example.com"}),false);
});
test("overview exposes aggregate operating metrics and configured runtime boundaries",()=>{
 const result=getAdminOperationsOverview(fakeDb(),{authMode:"supabase",dataPersistence:"unverified",persistentDataRequired:true,now:Date.parse("2026-11-11T00:00:00Z")});
 assert.equal(result.users,3);assert.equal(result.jobsByStatus.queued,2);assert.equal(result.usage30d.estimatedCostMicros,890000);assert.equal(result.runtime.persistentDataRequired,true);
});
test("admin directory and execution feeds return bounded, redacted operational fields",()=>{
 const db=fakeDb();const users=listAdminOperationUsers(db,{query:"a@",limit:500});const jobs=listAdminOperationJobs(db,{limit:10});const audit=listAdminOperationAudit(db,{limit:10});listAdminOperationJobs(db,{limit:null});
 assert.equal(users[0].email,"a@example.com");assert.equal(users[0].usage30d,4);assert.equal(jobs[0].jobType,"video.generate");assert.equal(audit[0].eventType,"project.created");
 assert.equal(db.calls[0].args[0].length>0,true);assert.equal(db.calls[0].args[1],"a@");assert.equal(db.calls[0].args[2],"a@");assert.equal(db.calls[0].args[3],"a@");assert.equal(db.calls[0].args[4],200);assert.equal(db.calls[3].args[0],100);
});
