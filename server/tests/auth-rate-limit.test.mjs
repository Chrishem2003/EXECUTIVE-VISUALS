import test from "node:test";
import assert from "node:assert/strict";
import {createAuthRateLimiter} from "../auth-rate-limit.mjs";

test("applies separate sign-in, registration and recovery budgets to normalized email hashes",()=>{
 const limiter=createAuthRateLimiter();
 for(let i=0;i<8;i++)assert.equal(limiter.allowEmail("signIn"," Owner@Example.com "),true);
 assert.equal(limiter.allowEmail("signIn","owner@example.com"),false);
 for(let i=0;i<5;i++)assert.equal(limiter.allowEmail("register","owner@example.com"),true);
 assert.equal(limiter.allowEmail("register","owner@example.com"),false);
 for(let i=0;i<3;i++)assert.equal(limiter.allowEmail("recover","owner@example.com"),true);
 assert.equal(limiter.allowEmail("recover","owner@example.com"),false);
 assert.equal(limiter.allowEmail("recover","another@example.com"),true);
});

test("expires a bucket after its policy window",()=>{
 let time=1000;const limiter=createAuthRateLimiter({now:()=>time});
 for(let i=0;i<3;i++)assert.equal(limiter.allowEmail("recover","person@example.com"),true);
 assert.equal(limiter.allowEmail("recover","person@example.com"),false);
 time+=60*60*1000;
 assert.equal(limiter.allowEmail("recover","person@example.com"),true);
});

test("bounds bucket growth and rejects invalid policy configuration",()=>{
 const limiter=createAuthRateLimiter({maxBuckets:100});
 for(let i=0;i<180;i++)assert.equal(limiter.allow("source:"+i,2,60000),true);
 assert.ok(limiter.size<=100);
 assert.throws(()=>createAuthRateLimiter({maxBuckets:10}),/bucket cap/);
 assert.throws(()=>limiter.allow("bad",0,60000),/parameters/);
 assert.throws(()=>limiter.allowEmail("unknown","person@example.com"),/purpose/);
});
