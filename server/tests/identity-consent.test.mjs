import test from "node:test";
import assert from "node:assert/strict";
import { assertIdentityUseAllowed } from "../identity-consent.mjs";

const now=new Date("2026-11-01T00:00:00Z");
test("fictional profiles may be used without real-person consent",()=>{
 const result=assertIdentityUseAllowed({id:"fictional-1",consent:{kind:"fictional"}},"likeness",now);
 assert.equal(result.basis,"fictional");
});
test("real-person identity use fails closed without documented permission",()=>{
 assert.throws(()=>assertIdentityUseAllowed({id:"person-1",consent:{kind:"not-granted"}},"likeness",now),{code:"IDENTITY_PERMISSION_REQUIRED"});
});
test("permission must explicitly cover the requested scope",()=>{
 const profile={id:"person-2",consent:{kind:"authorized",scopes:["likeness"],evidenceReference:"consent-record-42",expiresAt:"2027-01-01"}};
 assert.throws(()=>assertIdentityUseAllowed(profile,"voice",now),{code:"IDENTITY_PERMISSION_REQUIRED"});
});
test("documented permission is accepted only while current",()=>{
 const profile={id:"person-3",consent:{kind:"authorized",scopes:["likeness","voice"],evidenceReference:"signed-release-42",expiresAt:"2027-01-01"}};
 assert.equal(assertIdentityUseAllowed(profile,"voice",now).basis,"documented-authorization");
 assert.throws(()=>assertIdentityUseAllowed({...profile,consent:{...profile.consent,expiresAt:"2026-10-31"}},"voice",now),{code:"IDENTITY_PERMISSION_EXPIRED"});
});
test("invalid scope and missing evidence are rejected",()=>{
 assert.throws(()=>assertIdentityUseAllowed({consent:{kind:"fictional"}},"arbitrary",now),{code:"IDENTITY_SCOPE_INVALID"});
 assert.throws(()=>assertIdentityUseAllowed({consent:{kind:"authorized",scopes:["likeness"],expiresAt:"2027-01-01"}},"likeness",now),{code:"IDENTITY_PERMISSION_REQUIRED"});
});
