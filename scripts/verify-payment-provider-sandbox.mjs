import {pathToFileURL} from "node:url";
import {supabaseServerAuthHeaders} from "../server/supabase-server-credentials.mjs";

const PROJECT="bokxljngydmqrmktofwm";
const PADDLE="https://sandbox-api.paddle.com";
const PESAPAL="https://cybqa.pesapal.com/pesapalv3";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message,status)=>Object.assign(new Error(message),{code,status});
const required=[
 "SUPABASE_STAGING_URL","SUPABASE_STAGING_SECRET_KEY","PADDLE_SANDBOX_API_KEY",
 "PADDLE_WEBHOOK_SECRET","PESAPAL_SANDBOX_CONSUMER_KEY","PESAPAL_SANDBOX_CONSUMER_SECRET","PESAPAL_IPN_ID","PESAPAL_CALLBACK_URL"
];

function config(env){
 const missing=required.filter(name=>!String(env[name]||"").trim());
 if(missing.length)throw fail("PAYMENT_SANDBOX_CONFIG_MISSING","Sandbox payment-provider configuration is incomplete.");
 const url=new URL(env.SUPABASE_STAGING_URL);
 if(url.protocol!=="https:"||url.hostname!==PROJECT+".supabase.co"||url.username||url.password||url.search||url.hash)
  throw fail("PAYMENT_SANDBOX_PROJECT_INVALID","Payment sandbox acceptance is restricted to the approved staging Supabase project.");
 const paddleKey=String(env.PADDLE_SANDBOX_API_KEY);
 if(!paddleKey.includes("_sdbx_")||paddleKey.includes("_live_"))
  throw fail("PADDLE_SANDBOX_KEY_INVALID","Only a Paddle sandbox API key is accepted.");
 if(String(env.PADDLE_WEBHOOK_SECRET).length<16)
  throw fail("PADDLE_WEBHOOK_SECRET_INVALID","Paddle sandbox webhook secret is invalid.");
 if(!UUID.test(String(env.PESAPAL_IPN_ID)))
  throw fail("PESAPAL_IPN_ID_INVALID","Pesapal sandbox IPN ID must be a UUID.");
 const callback=new URL(env.PESAPAL_CALLBACK_URL);
 if(callback.protocol!=="https:"||callback.username||callback.password||callback.hash||
    callback.hostname!=="executive-visuals-cloud-staging.onrender.com"||callback.pathname!=="/api/webhooks/pesapal"||callback.search)
  throw fail("PESAPAL_CALLBACK_URL_INVALID","Pesapal sandbox callback must use the application's HTTPS GET IPN route /api/webhooks/pesapal.");
 return{origin:url.origin,supabaseKey:env.SUPABASE_STAGING_SECRET_KEY,paddleKey,
  paddleWebhookSecret:env.PADDLE_WEBHOOK_SECRET,pesapalKey:env.PESAPAL_SANDBOX_CONSUMER_KEY,
  pesapalSecret:env.PESAPAL_SANDBOX_CONSUMER_SECRET,ipnId:env.PESAPAL_IPN_ID,callbackUrl:callback.toString()};
}

async function readBounded(response){
 const reader=response.body?.getReader?.();
 if(!reader){
  const raw=await response.text();
  if(Buffer.byteLength(raw)>65536)throw fail("PAYMENT_PROVIDER_RESPONSE_TOO_LARGE","Provider response exceeded the safety limit.");
  return raw;
 }
 const chunks=[];let size=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;
   if(size>65536){await reader.cancel().catch(()=>{});throw fail("PAYMENT_PROVIDER_RESPONSE_TOO_LARGE","Provider response exceeded the safety limit.");}
   chunks.push(Buffer.from(value));
  }
 }finally{reader.releaseLock?.();}
 return Buffer.concat(chunks).toString("utf8");
}

async function request(fetchImpl,url,{method="GET",headers={},body=null,provider}={}){
 let response;
 try{
  response=await fetchImpl(url,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),
   signal:AbortSignal.timeout(15000),redirect:"error"});
 }catch{
  throw fail(provider+"_NETWORK_FAILED",provider+" sandbox endpoint could not be reached.");
 }
 const raw=await readBounded(response);
 let data=null;try{data=raw?JSON.parse(raw):null;}catch{throw fail(provider+"_RESPONSE_INVALID",provider+" sandbox returned invalid JSON.");}
 if(!response.ok)throw fail(provider+"_HTTP_"+response.status,provider+" sandbox rejected the verification request.",response.status);
 return data;
}

export async function verifyPaymentProviderSandbox({env=process.env,fetchImpl=globalThis.fetch}={}){
 if(typeof fetchImpl!=="function")throw new Error("A fetch implementation is required.");
 const c=config(env);
 const supabaseHeaders={...supabaseServerAuthHeaders(c.supabaseKey),"accept-profile":"executive_visuals",accept:"application/json"};
 const paddleHeaders={authorization:"Bearer "+c.paddleKey,accept:"application/json","paddle-version":"1"};
 const pesapalHeaders={"content-type":"application/json",accept:"application/json"};

 const paddleEvents=await request(fetchImpl,PADDLE+"/event-types",{headers:paddleHeaders,provider:"PADDLE"});
 if(!Array.isArray(paddleEvents?.data))throw fail("PADDLE_EVENT_TYPES_INVALID","Paddle sandbox did not return its event-type catalogue.");

 const paddleRows=await request(fetchImpl,c.origin+"/rest/v1/subscription_plan_provider_prices?select=provider_price_id,amount_minor,currency,active&provider=eq.paddle&active=eq.true",{
  headers:supabaseHeaders,provider:"SUPABASE"
 });
 if(!Array.isArray(paddleRows)||paddleRows.length<1)throw fail("PADDLE_PRICE_CONFIGURATION_MISSING","No active Paddle sandbox price mappings exist in the staging plan catalogue.");
 for(const row of paddleRows){
  const id=String(row?.provider_price_id||"");
  if(!/^pri_[A-Za-z0-9]+$/.test(id)||row.active!==true||!Number.isSafeInteger(Number(row.amount_minor))||Number(row.amount_minor)<1)
   throw fail("PADDLE_PRICE_MAPPING_INVALID","Staging contains an invalid active Paddle price mapping.");
  const price=await request(fetchImpl,PADDLE+"/prices/"+encodeURIComponent(id),{headers:paddleHeaders,provider:"PADDLE"});
  const actual=price?.data;
  if(actual?.id!==id||actual?.status!=="active"||
     Number(actual?.unit_price?.amount)!==Number(row.amount_minor)||
     String(actual?.unit_price?.currency_code||"").toUpperCase()!==String(row.currency||"").toUpperCase())
   throw fail("PADDLE_PRICE_CONFIGURATION_MISMATCH","A staging Paddle price is missing, inactive or does not match the server-side amount and currency.");
 }

 const tokenResponse=await request(fetchImpl,PESAPAL+"/api/Auth/RequestToken",{
  method:"POST",headers:pesapalHeaders,
  body:{consumer_key:c.pesapalKey,consumer_secret:c.pesapalSecret},provider:"PESAPAL"
 });
 const token=String(tokenResponse?.token||"");
 if(!token)throw fail("PESAPAL_TOKEN_MISSING","Pesapal sandbox did not issue an access token.");
 const ipns=await request(fetchImpl,PESAPAL+"/api/URLSetup/GetIpnList",{
  headers:{authorization:"Bearer "+token,accept:"application/json"},provider:"PESAPAL"
 });
 const registered=Array.isArray(ipns)?ipns:Array.isArray(ipns?.ipn_list)?ipns.ipn_list:[];
 if(!registered.some(item=>String(item?.ipn_id||"")===c.ipnId&&String(item?.url||"")===c.callbackUrl))
  throw fail("PESAPAL_IPN_NOT_REGISTERED","The configured Pesapal sandbox IPN ID is not registered to this merchant account.");

 const pesapalRows=await request(fetchImpl,c.origin+"/rest/v1/subscription_plan_provider_prices?select=amount_minor,currency,active&provider=eq.pesapal&active=eq.true",{
  headers:supabaseHeaders,provider:"SUPABASE"
 });
 if(!Array.isArray(pesapalRows)||pesapalRows.length<1||
    pesapalRows.some(row=>row.active!==true||String(row.currency||"").toUpperCase()!=="UGX"||!Number.isSafeInteger(Number(row.amount_minor))||Number(row.amount_minor)<1))
  throw fail("PESAPAL_PRICE_CONFIGURATION_INVALID","Staging must contain active UGX Pesapal subscription price mappings.");

 return{
  result:"sandbox_provider_acceptance_passed",
  paddle:{authenticated:true,activePricesVerified:paddleRows.length,webhookSecretConfigured:true},
  pesapal:{authenticated:true,registeredIpnVerified:true,activeUgxPricesVerified:pesapalRows.length},
  noCheckoutCreated:true,noPaymentInitiated:true,productionEndpointsUsed:false,credentialValuesExposed:false
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 verifyPaymentProviderSandbox().then(report=>console.log(JSON.stringify(report))).catch(error=>{
  console.log(JSON.stringify({result:"blocked_or_failed",code:error?.code||"PAYMENT_SANDBOX_FAILED",credentialValuesExposed:false}));
  process.exitCode=1;
 });
}
