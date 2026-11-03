import test from "node:test";
import assert from "node:assert/strict";
import {createRedisRestRateLimiter} from "../distributed-rate-limit.mjs";

const config={url:"https://redis.example.test",token:"test-token-that-is-long-enough"};

test("uses one atomic Redis script with a hashed namespaced key and expires its counter",async()=>{
 let request;
 const limiter=createRedisRestRateLimiter({...config,fetchImpl:async(url,options)=>{request={url:String(url),options};return {ok:true,json:async()=>({result:2})};}});
 assert.equal(await limiter.allow("203.0.113.10/auth",2,60000),true);
 assert.equal(request.url,config.url);
 assert.equal(request.options.method,"POST");
 assert.equal(request.options.headers.authorization,"Bearer "+config.token);
 const command=JSON.parse(request.options.body);
 assert.equal(command[0],"EVAL");
 assert.equal(command[2],"1");
 assert.match(command[3],/^executive-visuals:[a-f0-9]{64}$/);
 assert.equal(command[4],"60000");
 assert.match(command[1],/INCR/);
 assert.match(command[1],/PEXPIRE/);
 assert.equal(await limiter.allow("203.0.113.10/auth",2,60000),true);
});

test("denies requests over the shared counter limit",async()=>{
 const limiter=createRedisRestRateLimiter({...config,fetchImpl:async()=>({ok:true,json:async()=>({result:4})})});
 assert.equal(await limiter.allow("client",3,60000),false);
});

test("applies normalized per-email budgets without sending plaintext email in the key",async()=>{
 let command;
 const limiter=createRedisRestRateLimiter({...config,fetchImpl:async(url,options)=>{command=JSON.parse(options.body);return {ok:true,json:async()=>({result:1})};}});
 assert.equal(await limiter.allowEmail("signIn"," Owner@Example.com "),true);
 assert.match(command[3],/^executive-visuals:[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(command).includes("owner@example.com"),false);
 assert.equal(await limiter.allowEmail("recover","invalid"),true);
 assert.equal(limiter.backend,"redis-rest");
});

test("fails closed when Redis is unavailable or returns invalid counters",async()=>{
 const unavailable=createRedisRestRateLimiter({...config,fetchImpl:async()=>{throw new Error("network down");}});
 await assert.rejects(()=>unavailable.allow("client",2,60000),error=>error.code==="RATE_LIMIT_STORE_UNAVAILABLE");
 const badResponse=createRedisRestRateLimiter({...config,fetchImpl:async()=>({ok:false,json:async()=>({})})});
 await assert.rejects(()=>badResponse.allow("client",2,60000),error=>error.code==="RATE_LIMIT_STORE_UNAVAILABLE");
 const badCounter=createRedisRestRateLimiter({...config,fetchImpl:async()=>({ok:true,json:async()=>({result:"1"})})});
 await assert.rejects(()=>badCounter.allow("client",2,60000),error=>error.code==="RATE_LIMIT_STORE_UNAVAILABLE");
});

test("rejects insecure endpoint and invalid Redis configuration",()=>{
 assert.throws(()=>createRedisRestRateLimiter({url:"http://redis.example.test",token:config.token}),/HTTPS/);
 assert.throws(()=>createRedisRestRateLimiter({url:config.url,token:"short"}),/token/);
 assert.throws(()=>createRedisRestRateLimiter({...config,namespace:"bad namespace"}),/namespace/);
});
