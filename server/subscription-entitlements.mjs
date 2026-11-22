const fail=(code,message,status=403)=>Object.assign(new Error(message),{code,status});
const FORBIDDEN_SEGMENTS=new Set(["__proto__","prototype","constructor"]);
const PLAN_CODE=/^[a-z][a-z0-9_-]{1,63}$/;
const MAX_SNAPSHOT_BYTES=16*1024;

function object(value){return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function field(row,...names){for(const name of names)if(row?.[name]!==undefined)return row[name];return undefined;}
function immutableJsonObject(value){
 if(!object(value))return null;
 let encoded;
 try{encoded=JSON.stringify(value);}catch{return null;}
 if(typeof encoded!=="string"||Buffer.byteLength(encoded,"utf8")>MAX_SNAPSHOT_BYTES)return null;
 let copy;
 try{copy=JSON.parse(encoded);}catch{return null;}
 return deepFreeze(copy);
}
function deepFreeze(value){
 if(value&&typeof value==="object"&&!Object.isFrozen(value)){
  for(const child of Object.values(value))deepFreeze(child);
  Object.freeze(value);
 }
 return value;
}
function dateValue(value){
 if(typeof value!=="string"&&!(value instanceof Date))return null;
 const ms=value instanceof Date?value.getTime():Date.parse(value);
 return Number.isFinite(ms)?ms:null;
}
function denied(reason){return Object.freeze({allowed:false,reason});}
function allowed(value){return Object.freeze({allowed:true,value});}

export function resolveSubscriptionEntitlements(subscription,{now=()=>new Date()}={}){
 if(!object(subscription))return Object.freeze({active:false,reason:"A verified subscription record is required."});
 const status=String(field(subscription,"status")||"").trim().toLowerCase();
 if(status!=="active")return Object.freeze({active:false,reason:"An active subscription is required."});
 const planCode=String(field(subscription,"plan_code","planCode")||"").trim().toLowerCase();
 const planVersion=field(subscription,"plan_version","planVersion");
 if(!PLAN_CODE.test(planCode)||!Number.isSafeInteger(Number(planVersion))||Number(planVersion)<1)
  return Object.freeze({active:false,reason:"The subscription plan identity or version is invalid."});
 const periodEnd=dateValue(field(subscription,"current_period_end","currentPeriodEnd","periodEnd"));
 const clock=now();
 const nowMs=dateValue(clock);
 if(periodEnd===null||nowMs===null||periodEnd<=nowMs)
  return Object.freeze({active:false,reason:"The subscription billing period has expired or cannot be verified."});
 const snapshot=immutableJsonObject(field(subscription,"entitlements_snapshot","entitlementsSnapshot"));
 if(!snapshot)return Object.freeze({active:false,reason:"The server-side entitlement snapshot is missing or invalid."});
 return Object.freeze({
  active:true,planCode,planVersion:Number(planVersion),
  expiresAt:new Date(periodEnd).toISOString(),
  cancelAtPeriodEnd:field(subscription,"cancel_at_period_end","cancelAtPeriodEnd")===true,
  entitlements:snapshot
 });
}

function readPath(root,path){
 if(typeof path!=="string"||path.length<1||path.length>180)return {valid:false};
 const segments=path.split(".");
 if(segments.length>8||segments.some(segment=>! /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(segment)||FORBIDDEN_SEGMENTS.has(segment)))return {valid:false};
 let value=root;
 for(const segment of segments){
  if(!object(value)||!Object.hasOwn(value,segment))return {valid:false};
  value=value[segment];
 }
 return {valid:true,value};
}

export function evaluateSubscriptionEntitlement(resolved,{path,requested=true}={}){
 if(!resolved?.active)return denied(resolved?.reason||"An active subscription is required.");
 const result=readPath(resolved.entitlements,path);
 if(!result.valid)return denied("This capability is not included in the active plan.");
 const value=result.value;
 if(typeof value==="boolean")return value===requested&&requested===true?allowed(true):denied("This capability is not included in the active plan.");
 if(Array.isArray(value))return typeof requested==="string"&&value.includes(requested)?allowed(requested):denied("The requested provider, model or option is not included in the active plan.");
 if(typeof value==="number"&&Number.isFinite(value)&&typeof requested==="number"&&Number.isFinite(requested)&&requested>=0)
  return requested<=value?allowed(value):denied("The requested usage exceeds the active plan limit.");
 return denied("The requested entitlement cannot be verified.");
}

export function evaluateSubscriptionLimit(resolved,{name,used=0,requested=1}={}){
 if(!resolved?.active)return denied(resolved?.reason||"An active subscription is required.");
 if(typeof name!=="string"||! /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)||FORBIDDEN_SEGMENTS.has(name))
  return denied("A valid plan limit name is required.");
 if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(requested)||requested<1)
  return denied("Usage counters must be non-negative safe integers.");
 const result=readPath(resolved.entitlements,"limits."+name);
 if(!result.valid||!Number.isSafeInteger(result.value)||result.value<0)
  return denied("The requested plan limit is not configured.");
 return used+requested<=result.value
  ?allowed({limit:result.value,used,requested,remaining:result.value-used-requested})
  :denied("The requested operation exceeds the active plan limit.");
}

export function assertSubscriptionEntitlement(resolved,options){
 const result=evaluateSubscriptionEntitlement(resolved,options);
 if(!result.allowed)throw fail("SUBSCRIPTION_ENTITLEMENT_REQUIRED",result.reason,403);
 return result.value;
}

export function assertSubscriptionLimit(resolved,options){
 const result=evaluateSubscriptionLimit(resolved,options);
 if(!result.allowed)throw fail("SUBSCRIPTION_LIMIT_EXCEEDED",result.reason,403);
 return result.value;
}
