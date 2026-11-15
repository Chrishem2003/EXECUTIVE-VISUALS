import test from "node:test";
import assert from "node:assert/strict";

test("admin capability is denied until the authenticated capability response confirms access",async()=>{
 const originalFetch=globalThis.fetch;
 const originalWindow=globalThis.window;
 let requests=0,events=0;
 globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({capabilities:{admin:true}}),{status:200,headers:{"content-type":"application/json"}});};
 globalThis.window={dispatchEvent(event){if(event.type==="ev:admin-operations-capability")events++;return true;}};
 try{
  const module=await import("../../src/platform/admin-operations-capability.ts?admin-capability-allow");
  assert.equal(module.isAdminOperationsAllowed(),false);
  const [first,second]=await Promise.all([module.initializeAdminOperationsCapability(),module.initializeAdminOperationsCapability()]);
  assert.equal(first,true);
  assert.equal(second,true);
  assert.equal(module.isAdminOperationsAllowed(),true);
  assert.equal(requests,1);
  assert.equal(events,1);
 }finally{
  globalThis.fetch=originalFetch;
  if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;
 }
});

test("admin capability fails closed when the session endpoint rejects",async()=>{
 const originalFetch=globalThis.fetch;
 const originalWindow=globalThis.window;
 globalThis.fetch=async()=>new Response("{}",{status:401,headers:{"content-type":"application/json"}});
 globalThis.window={dispatchEvent(){return true;}};
 try{
  const module=await import("../../src/platform/admin-operations-capability.ts?admin-capability-deny");
  assert.equal(await module.initializeAdminOperationsCapability(),false);
  assert.equal(module.isAdminOperationsAllowed(),false);
 }finally{
  globalThis.fetch=originalFetch;
  if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;
 }
});
