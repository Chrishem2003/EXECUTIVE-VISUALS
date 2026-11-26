import assert from "node:assert/strict";
const paddleKey=process.env.PADDLE_SANDBOX_API_KEY||"";
const pesapalKey=process.env.PESAPAL_SANDBOX_CONSUMER_KEY||"";
const pesapalSecret=process.env.PESAPAL_SANDBOX_CONSUMER_SECRET||"";
for(const [name,value] of Object.entries({PADDLE_SANDBOX_API_KEY:paddleKey,PESAPAL_SANDBOX_CONSUMER_KEY:pesapalKey,PESAPAL_SANDBOX_CONSUMER_SECRET:pesapalSecret}))if(!value)throw new Error("Missing staging payment sandbox secret: "+name);
if(!paddleKey.includes("_sdbx_")||paddleKey.includes("_live_"))throw new Error("Paddle credential is not recognizably sandbox-scoped.");
const paddle=await fetch("https://sandbox-api.paddle.com/event-types",{headers:{authorization:"Bearer "+paddleKey,accept:"application/json"},signal:AbortSignal.timeout(15000),redirect:"error"});
const paddleBody=await paddle.text();if(!paddle.ok)throw new Error("Paddle sandbox authentication/readiness failed with HTTP "+paddle.status);
let paddleJson;try{paddleJson=JSON.parse(paddleBody);}catch{throw new Error("Paddle sandbox returned invalid JSON.");}
assert.ok(Array.isArray(paddleJson.data),"Paddle sandbox event-types response is invalid.");
const pesapal=await fetch("https://cybqa.pesapal.com/pesapalv3/api/Auth/RequestToken",{
 method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
 body:JSON.stringify({consumer_key:pesapalKey,consumer_secret:pesapalSecret}),
 signal:AbortSignal.timeout(15000),redirect:"error"
});
const pesapalBody=await pesapal.text();if(!pesapal.ok)throw new Error("Pesapal sandbox authentication failed with HTTP "+pesapal.status);
let pesapalJson;try{pesapalJson=JSON.parse(pesapalBody);}catch{throw new Error("Pesapal sandbox returned invalid JSON.");}
assert.ok(typeof pesapalJson.token==="string"&&pesapalJson.token.length>20,"Pesapal sandbox did not return a valid access token.");
console.log(JSON.stringify({result:"sandbox_credentials_verified",paddle:{environment:"sandbox",eventTypes:paddleJson.data.length,authenticated:true},pesapal:{environment:"sandbox",tokenIssued:true}}));
