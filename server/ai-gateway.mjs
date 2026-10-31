const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));

export async function generateText({prompt,systemPrompt="",temperature=0.7,maxTokens=1024}={}) {
  if(process.env.AI_GATEWAY_ENABLED!=="true")throw Object.assign(new Error("Text-model execution is disabled by server configuration."),{code:"AI_GATEWAY_DISABLED"});
  const rawUrl=String(process.env.AI_GATEWAY_URL||"").trim(),model=String(process.env.AI_GATEWAY_MODEL||"").trim();
  if(!rawUrl||!model)throw Object.assign(new Error("Configure the server-side text gateway URL and model before running this node."),{code:"AI_GATEWAY_CONFIG_INVALID"});
  let base;
  try{base=new URL(rawUrl);}catch{throw Object.assign(new Error("The configured text gateway URL is invalid."),{code:"AI_GATEWAY_CONFIG_INVALID"});}
  if(base.username||base.password||base.search||base.hash)throw Object.assign(new Error("The text gateway URL must not contain credentials, query parameters or fragments."),{code:"AI_GATEWAY_CONFIG_INVALID"});
  const loopback=["localhost","127.0.0.1","::1"].includes(base.hostname.toLowerCase());
  if(base.protocol!=="https:"&&!loopback)throw Object.assign(new Error("Non-local text gateways must use HTTPS."),{code:"AI_GATEWAY_INSECURE_URL"});
  const prefix=base.pathname.endsWith("/")?base.pathname:base.pathname+"/";
  const endpoint=new URL(prefix+"chat/completions",base.origin);
  const timeoutMs=Math.max(1000,Math.min(180000,Number(process.env.AI_GATEWAY_TIMEOUT_MS)||90000));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  const headers={"content-type":"application/json"};
  const apiKey=String(process.env.AI_GATEWAY_API_KEY||"").trim();
  if(apiKey)headers.authorization="Bearer "+apiKey;
  const request={
    model,
    messages:[
      ...(String(systemPrompt||"").trim()?[{role:"system",content:String(systemPrompt).slice(0,12000)}]:[]),
      {role:"user",content:String(prompt||"").slice(0,50000)}
    ],
    temperature:clamp(temperature,0,2),
    max_tokens:Math.round(clamp(maxTokens,1,4096))
  };
  try{
    let response;
    try{response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify(request),signal:controller.signal,redirect:"error"});}
    catch(error){
      if(error?.name==="AbortError")throw Object.assign(new Error("Text gateway request timed out."),{code:"AI_GATEWAY_TIMEOUT"});
      throw Object.assign(new Error("Text gateway could not be reached."),{code:"AI_GATEWAY_UNAVAILABLE"});
    }
    if(response.status===429)throw Object.assign(new Error("Text gateway rate limit reached. Retry after the configured provider window."),{code:"AI_GATEWAY_RATE_LIMITED"});
    if(response.status>=500)throw Object.assign(new Error("Text gateway returned a temporary server error ("+response.status+")."),{code:"AI_GATEWAY_SERVER_ERROR"});
    if(!response.ok)throw Object.assign(new Error("Text gateway rejected the request ("+response.status+"). Check its server-side configuration and model access."),{code:"AI_GATEWAY_REQUEST_REJECTED"});
    let payload;
    try{payload=await response.json();}catch{throw Object.assign(new Error("Text gateway returned an invalid response."),{code:"AI_GATEWAY_INVALID_RESPONSE"});}
    const content=payload?.choices?.[0]?.message?.content;
    const text=typeof content==="string"?content:Array.isArray(content)?content.map(part=>typeof part?.text==="string"?part.text:"").join(""):"";
    if(!text.trim())throw Object.assign(new Error("Text gateway returned no assistant text."),{code:"AI_GATEWAY_EMPTY_RESPONSE"});
    const usage=payload.usage&&typeof payload.usage==="object"?{
      promptTokens:Number(payload.usage.prompt_tokens)||0,
      completionTokens:Number(payload.usage.completion_tokens)||0,
      totalTokens:Number(payload.usage.total_tokens)||0
    }:null;
    return {text,model:String(payload.model||model),usage};
  }finally{clearTimeout(timer);}
}
