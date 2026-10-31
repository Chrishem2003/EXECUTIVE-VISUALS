import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateText } from "../ai-gateway.mjs";

const saved={};
const keys=["AI_GATEWAY_ENABLED","AI_GATEWAY_URL","AI_GATEWAY_MODEL","AI_GATEWAY_API_KEY","AI_GATEWAY_TIMEOUT_MS","AI_GATEWAY_ALLOW_REMOTE"];
for(const key of keys)saved[key]=process.env[key];
function restore(){for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
test("text gateway sends approved request configuration and normalizes response usage",async()=>{
 const server=createServer(async(req,res)=>{
  let body="";for await(const chunk of req)body+=chunk;
  assert.equal(req.url,"/v1/chat/completions");
  assert.equal(req.headers.authorization,"Bearer test-secret-not-logged");
  const payload=JSON.parse(body);
  assert.equal(payload.model,"test-model");
  assert.equal(payload.messages[0].role,"system");
  assert.equal(payload.messages[1].content,"Write a short scene");
  assert.equal(payload.max_tokens,256);
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({model:"test-model-v2",choices:[{message:{content:"A scene appears."}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const address=server.address();
  process.env.AI_GATEWAY_ENABLED="true";process.env.AI_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";process.env.AI_GATEWAY_MODEL="test-model";process.env.AI_GATEWAY_API_KEY="test-secret-not-logged";process.env.AI_GATEWAY_TIMEOUT_MS="5000";
  const result=await generateText({prompt:"Write a short scene",systemPrompt:"You are a screenwriter",temperature:0.4,maxTokens:256});
  assert.equal(result.text,"A scene appears.");
  assert.equal(result.model,"test-model-v2");
  assert.deepEqual(result.usage,{promptTokens:10,completionTokens:5,totalTokens:15});
 }finally{await new Promise(resolve=>server.close(resolve));restore();}
});
test("text gateway is disabled by default and rejects insecure remote endpoints",async()=>{
 process.env.AI_GATEWAY_ENABLED="false";
 await assert.rejects(()=>generateText({prompt:"hello"}),error=>error.code==="AI_GATEWAY_DISABLED");
 process.env.AI_GATEWAY_ENABLED="true";process.env.AI_GATEWAY_URL="http://example.com/v1";process.env.AI_GATEWAY_MODEL="test-model";
 await assert.rejects(()=>generateText({prompt:"hello"}),error=>error.code==="AI_GATEWAY_INSECURE_URL");
 process.env.AI_GATEWAY_URL="https://gateway.example.test/v1";
 await assert.rejects(()=>generateText({prompt:"hello"}),error=>error.code==="AI_GATEWAY_REMOTE_DISABLED");
 restore();
});
test("text gateway rate limits and server failures are normalized without leaking secrets",async()=>{
 const server=createServer((req,res)=>{res.writeHead(429,{"content-type":"application/json"});res.end(JSON.stringify({error:"secret provider details"}));});
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const address=server.address();
  process.env.AI_GATEWAY_ENABLED="true";process.env.AI_GATEWAY_URL="http://127.0.0.1:"+address.port+"/v1";process.env.AI_GATEWAY_MODEL="test-model";process.env.AI_GATEWAY_API_KEY="test-secret-not-logged";
  await assert.rejects(()=>generateText({prompt:"hello"}),error=>error.code==="AI_GATEWAY_RATE_LIMITED"&&!error.message.includes("secret provider details"));
 }finally{await new Promise(resolve=>server.close(resolve));restore();}
});
