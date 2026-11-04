import {createHash} from "node:crypto";

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POLICIES=Object.freeze({
 signIn:Object.freeze({limit:8,windowMs:15*60*1000}),
 register:Object.freeze({limit:5,windowMs:60*60*1000}),
 recover:Object.freeze({limit:3,windowMs:60*60*1000})
});

export function createAuthRateLimiter({maxBuckets=20000,now=()=>Date.now()}={}){
 if(!Number.isInteger(maxBuckets)||maxBuckets<100||maxBuckets>1000000)throw new Error("Authentication rate limiter bucket cap is invalid.");
 const buckets=new Map();let operations=0;
 function allow(key,limit,windowMs){
  if(typeof key!=="string"||!key||!Number.isInteger(limit)||limit<1||!Number.isInteger(windowMs)||windowMs<1000)throw new Error("Authentication rate limit parameters are invalid.");
  const time=now(),old=buckets.get(key);
  if(!old||time-old.start>=windowMs)buckets.set(key,{start:time,count:1});
  else{old.count++;if(old.count>limit)return false;}
  if(++operations%256===0||buckets.size>maxBuckets){
   for(const [bucket,value] of buckets)if(time-value.start>=Math.max(windowMs,60*60*1000))buckets.delete(bucket);
   while(buckets.size>maxBuckets)buckets.delete(buckets.keys().next().value);
  }
  return true;
 }
 function allowEmail(purpose,email){
  const normalized=String(email||"").trim().toLowerCase();
  const policy=POLICIES[purpose];
  if(!policy)throw new Error("Unknown authentication rate-limit purpose.");
  if(!EMAIL.test(normalized))return true;
  const digest=createHash("sha256").update(normalized).digest("hex");
  return allow("auth-email:"+purpose+":"+digest,policy.limit,policy.windowMs);
 }
 return Object.freeze({allow,allowEmail,get size(){return buckets.size;}});
}
