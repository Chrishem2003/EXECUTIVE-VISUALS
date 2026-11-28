import test from "node:test";
import assert from "node:assert/strict";
import {verifyPaymentProviderSandbox} from "../../scripts/verify-payment-provider-sandbox.mjs";

const project="bokxljngydmqrmktofwm";
const env={
 SUPABASE_STAGING_URL:"https://"+project+".supabase.co",
 SUPABASE_STAGING_SECRET_KEY:"sb_secret_test_placeholder",
 PADDLE_SANDBOX_API_KEY:"pdl_sdbx_apikey_TEST_PLACEHOLDER",
 PADDLE_WEBHOOK_SECRET:"webhook-secret-test-placeholder-not-a-real-key",
 PESAPAL_SANDBOX_CONSUMER_KEY:"pesapal-test-consumer-key",
 PESAPAL_SANDBOX_CONSUMER_SECRET:"pesapal-test-consumer-secret",
 PESAPAL_IPN_ID:"123e4567-e89b-42d3-a456-426614174000",
 PESAPAL_CALLBACK_URL:"https://executive-visuals-cloud-staging.onrender.com/api/webhooks/pesapal"
};
const paddlePrice={provider_price_id:"pri_12345678901234567890123456",amount_minor:25000,currency:"USD",active:true};
const pesapalPrice={amount_minor:75000,currency:"UGX",active:true};

function mockFetch({price=paddlePrice,ipn=true,paddlePrices=[paddlePrice],pesapalPrices=[pesapalPrice]}={}){
 const calls=[];
 const fetchImpl=async(url,options={})=>{
  const target=new URL(url);calls.push({url:target.toString(),method:options.method||"GET",headers:options.headers,body:options.body});
  if(target.origin==="https://sandbox-api.paddle.com"&&target.pathname==="/event-types")
   return Response.json({data:[{name:"transaction.completed"}]});
  if(target.origin==="https://sandbox-api.paddle.com"&&target.pathname.startsWith("/prices/"))
   return Response.json({data:{id:price.provider_price_id,status:"active",unit_price:{amount:String(price.amount_minor),currency_code:price.currency}}});
  if(target.pathname.includes("subscription_plan_provider_prices")&&target.searchParams.get("provider")==="eq.paddle")
   return Response.json(paddlePrices);
  if(target.pathname.includes("subscription_plan_provider_prices")&&target.searchParams.get("provider")==="eq.pesapal")
   return Response.json(pesapalPrices);
  if(target.origin==="https://cybqa.pesapal.com"&&target.pathname==="/pesapalv3/api/Auth/RequestToken")
   return Response.json({token:"short-lived-sandbox-token"});
  if(target.origin==="https://cybqa.pesapal.com"&&target.pathname==="/pesapalv3/api/URLSetup/GetIpnList")
   return Response.json(ipn?[{ipn_id:env.PESAPAL_IPN_ID,url:env.PESAPAL_CALLBACK_URL}]:[]);
  throw new Error("Unexpected sandbox request "+target.toString());
 };
 return{fetchImpl,calls};
}

test("verifies Paddle sandbox, active server-mapped prices, Pesapal sandbox and registered IPN without checkout",async()=>{
 const f=mockFetch();
 const result=await verifyPaymentProviderSandbox({env,fetchImpl:f.fetchImpl});
 assert.equal(result.result,"sandbox_provider_acceptance_passed");
 assert.equal(result.paddle.activePricesVerified,1);
 assert.equal(result.pesapal.registeredIpnVerified,true);
 assert.equal(result.noCheckoutCreated,true);
 assert.equal(result.noPaymentInitiated,true);
 assert.equal(result.productionEndpointsUsed,false);
 assert.ok(f.calls.some(x=>x.url==="https://sandbox-api.paddle.com/event-types"));
 assert.ok(f.calls.some(x=>x.url.includes("/prices/"+paddlePrice.provider_price_id)));
 assert.ok(f.calls.some(x=>x.url.endsWith("/api/Auth/RequestToken")&&x.method==="POST"));
 assert.ok(f.calls.some(x=>x.url.endsWith("/api/URLSetup/GetIpnList")));
 assert.equal(f.calls.some(x=>/Transactions\/SubmitOrderRequest|\/transactions/i.test(x.url)),false);
 assert.ok(f.calls.every(x=>x.url.includes(project+".supabase.co")||x.url.includes("sandbox-api.paddle.com")||x.url.includes("cybqa.pesapal.com")));
});

test("refuses an unrelated Supabase project before contacting providers",async()=>{
 let calls=0;
 await assert.rejects(()=>verifyPaymentProviderSandbox({env:{...env,SUPABASE_STAGING_URL:"https://production.supabase.co"},fetchImpl:async()=>{calls++;}}),{code:"PAYMENT_SANDBOX_PROJECT_INVALID"});
 assert.equal(calls,0);
});

test("refuses Paddle live API keys before any provider request",async()=>{
 let calls=0;
 await assert.rejects(()=>verifyPaymentProviderSandbox({env:{...env,PADDLE_SANDBOX_API_KEY:"pdl_live_apikey_placeholder"},fetchImpl:async()=>{calls++;}}),{code:"PADDLE_SANDBOX_KEY_INVALID"});
 assert.equal(calls,0);
});

test("blocks when a Paddle price does not match the staging amount and currency",async()=>{
 const f=mockFetch({price:{...paddlePrice,amount_minor:25001}});
 await assert.rejects(()=>verifyPaymentProviderSandbox({env,fetchImpl:f.fetchImpl}),{code:"PADDLE_PRICE_CONFIGURATION_MISMATCH"});
});

test("blocks when the configured Pesapal IPN is not registered",async()=>{
 const f=mockFetch({ipn:false});
 await assert.rejects(()=>verifyPaymentProviderSandbox({env,fetchImpl:f.fetchImpl}),{code:"PESAPAL_IPN_NOT_REGISTERED"});
});

test("blocks when no active provider price mappings exist",async()=>{
 const f=mockFetch({paddlePrices:[]});
 await assert.rejects(()=>verifyPaymentProviderSandbox({env,fetchImpl:f.fetchImpl}),{code:"PADDLE_PRICE_CONFIGURATION_MISSING"});
});

test("blocks when the registered Pesapal IPN ID points to a different callback URL",async()=>{
 const calls=[];
 const f=mockFetch();
 const wrapped=async(url,options)=>{
  const target=new URL(url);
  if(target.pathname==="/pesapalv3/api/URLSetup/GetIpnList")
   return Response.json([{ipn_id:env.PESAPAL_IPN_ID,url:"https://wrong.example.test/ipn"}]);
  return f.fetchImpl(url,options);
 };
 await assert.rejects(()=>verifyPaymentProviderSandbox({env,fetchImpl:wrapped}),{code:"PESAPAL_IPN_NOT_REGISTERED"});
});

test("rejects a Pesapal callback URL that is not the application's registered GET IPN route",async()=>{
 let calls=0;
 await assert.rejects(()=>verifyPaymentProviderSandbox({
  env:{...env,PESAPAL_CALLBACK_URL:"https://executive-visuals-cloud-staging.onrender.com/api/billing/pesapal/ipn"},
  fetchImpl:async()=>{calls++;}
 }),{code:"PESAPAL_CALLBACK_URL_INVALID"});
 assert.equal(calls,0);
});
