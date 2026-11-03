import {createHash} from "node:crypto";

const POLICIES=Object.freeze({
 signIn:Object.freeze({limit:8,windowMs:15*60*1000}),
 register:Object.freeze({limit:5,windowMs:60*60*1000}),
 recover:Object.freeze({limit:3,windowMs:60*60*1000})
});
const SCRIPT="local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; return count";

export function createRedisRestRateLimiter({url,token,fetchImpl=globalThis.fetch,namespace="executive-visuals",timeoutMs=2500}={}) {
 let endpoint;
 try { endpoint=new URL(url); } catch { throw new Error("Rate-limit Redis REST URL is invalid."); }
 if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.hash)throw new Error("Rate-limit Redis REST URL must be HTTPS and contain no embedded credentials or fragment.");
 if(typeof token!=="string"||token.length<16)throw new Error("Rate-limit Redis REST token is missing or invalid.");
 if(typeof fetchImpl!=="function")throw new Error("Fetch is required for the Redis REST rate limiter.");
 if(typeof namespace!=="string"||!/^[a-zA-Z0-9:_-]{1,80}$/.test(namespace))throw new Error("Rate-limit Redis namespace is invalid.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<250||timeoutMs>10000)throw new Error("Rate-limit Redis timeout is invalid.");

 async function allow(key,limit,windowMs) {
  if(typeof key!=="string"||!key||!Number.isInteger(limit)||limit<1||!Number.isInteger(windowMs)||windowMs<1000)throw new Error("Authentication rate limit parameters are invalid.");
  const digest=createHash("sha256").update(key).digest("hex");
  const redisKey=namespace+":"+digest;
  let response;
  try {
   response=await fetchImpl(endpoint,{method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(["EVAL",SCRIPT,"1",redisKey,String(windowMs)]),signal:AbortSignal.timeout(timeoutMs)});
  } catch {
   throw Object.assign(new Error("Distributed rate-limit service is unavailable."),{code:"RATE_LIMIT_STORE_UNAVAILABLE"});
  }
  if(!response?.ok)throw Object.assign(new Error("Distributed rate-limit service rejected the request."),{code:"RATE_LIMIT_STORE_UNAVAILABLE"});
  let payload;
  try {payload=await response.json();} catch {throw Object.assign(new Error("Distributed rate-limit service returned an invalid response."),{code:"RATE_LIMIT_STORE_UNAVAILABLE"});}
  const count=payload?.result;
  if(!Number.isSafeInteger(count)||count<1)throw Object.assign(new Error("Distributed rate-limit service returned an invalid counter."),{code:"RATE_LIMIT_STORE_UNAVAILABLE"});
  return count<=limit;
 }

 async function allowEmail(purpose,email) {
  const normalized=String(email||"").trim().toLowerCase();
  const policy=POLICIES[purpose];
  if(!policy)throw new Error("Unknown authentication rate-limit purpose.");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))return true;
  const digest=createHash("sha256").update(normalized).digest("hex");
  return allow("auth-email:"+purpose+":"+digest,policy.limit,policy.windowMs);
 }
 return Object.freeze({allow,allowEmail,backend:"redis-rest"});
}
