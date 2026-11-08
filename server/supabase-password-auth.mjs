const fail=(message,code,status=502)=>Object.assign(new Error(message),{code,status});
function endpoint(base,path){
 let url;try{url=new URL(base);}catch{throw fail("Supabase URL is invalid.","SUPABASE_AUTH_CONFIG_INVALID",500);}
 if(url.protocol!=="https:"&&!["localhost","127.0.0.1","::1"].includes(url.hostname))throw fail("Supabase authentication requires HTTPS.","SUPABASE_AUTH_CONFIG_INVALID",500);
 if(url.username||url.password||url.search||url.hash)throw fail("Supabase URL must not contain credentials or query parameters.","SUPABASE_AUTH_CONFIG_INVALID",500);
 return new URL(path,url.origin);
}
async function request({supabaseUrl,publishableKey,path,method="GET",body,accessToken="",fetchImpl=fetch}){
 const key=String(publishableKey||"").trim();
 if(!key)throw fail("Supabase publishable key is not configured.","SUPABASE_AUTH_CONFIG_INVALID",500);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  let response;
  try{
   response=await fetchImpl(endpoint(supabaseUrl,path),{
    method,redirect:"error",signal:controller.signal,
    headers:{"apikey":key,"authorization":"Bearer "+(accessToken||key),"content-type":"application/json"},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
   });
  }catch(error){
   if(error?.name==="AbortError")throw fail("Identity provider request timed out.","SUPABASE_AUTH_TIMEOUT",504);
   throw fail("Identity provider is temporarily unavailable.","SUPABASE_AUTH_UNAVAILABLE",502);
  }
  const raw=await response.text();
  if(raw.length>1024*1024)throw fail("Identity provider returned an oversized response.","SUPABASE_AUTH_INVALID_RESPONSE",502);
  let payload={};try{payload=raw?JSON.parse(raw):{};}catch{throw fail("Identity provider returned invalid JSON.","SUPABASE_AUTH_INVALID_RESPONSE",502);}
  if(response.status===429)throw fail("Too many sign-in attempts. Try again shortly.","AUTH_RATE_LIMITED",429);
  if(!response.ok){
   if(response.status===400||response.status===401)throw fail("Email or password is incorrect, or the account requires email confirmation.","INVALID_CREDENTIALS",401);
   if(response.status===422)throw fail(String(payload.msg||payload.message||"The account details were rejected."),"AUTH_INPUT_REJECTED",400);
   throw fail("Identity provider request failed ("+response.status+").","SUPABASE_AUTH_FAILED",502);
  }
  return payload;
 }finally{clearTimeout(timer);}
}
function sessionFrom(payload){
 if(!payload||typeof payload.access_token!=="string"||typeof payload.refresh_token!=="string"||!payload.user?.id)
  throw fail("Identity provider did not return a complete authenticated session.","SUPABASE_AUTH_INVALID_RESPONSE",502);
 return {accessToken:payload.access_token,refreshToken:payload.refresh_token,expiresIn:Math.max(60,Number(payload.expires_in)||3600),user:{id:String(payload.user.id),email:String(payload.user.email||"")}};
}
export async function signInWithSupabasePassword({supabaseUrl,publishableKey,email,password,fetchImpl=fetch}){
 const normalizedEmail=String(email||"").trim().toLowerCase(),secret=String(password||"");
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)||secret.length<1||secret.length>256)throw fail("Enter a valid email and password.","INVALID_CREDENTIALS",400);
 return sessionFrom(await request({supabaseUrl,publishableKey,path:"/auth/v1/token?grant_type=password",method:"POST",body:{email:normalizedEmail,password:secret},fetchImpl}));
}
export async function signUpWithSupabasePassword({supabaseUrl,publishableKey,email,password,fetchImpl=fetch}){
 const normalizedEmail=String(email||"").trim().toLowerCase(),secret=String(password||"");
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)||secret.length<12||secret.length>256)throw fail("Enter a valid email and a password of at least 12 characters.","INVALID_CREDENTIALS",400);
 const payload=await request({supabaseUrl,publishableKey,path:"/auth/v1/signup",method:"POST",body:{email:normalizedEmail,password:secret},fetchImpl});
 if(typeof payload.access_token!=="string"||typeof payload.refresh_token!=="string"||!payload.user?.id)
  return {confirmationRequired:true,user:payload.user?.id?{id:String(payload.user.id),email:String(payload.user.email||normalizedEmail)}:null};
 return {...sessionFrom(payload),confirmationRequired:false};
}
export async function requestSupabasePasswordRecovery({supabaseUrl,publishableKey,email,redirectTo,fetchImpl=fetch}){
 const normalizedEmail=String(email||"").trim().toLowerCase();
 if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(normalizedEmail))throw fail("Enter a valid email address.","INVALID_EMAIL",400);
 let redirect;
 try{redirect=new URL(String(redirectTo||""));}catch{throw fail("Password recovery redirect is not configured.","SUPABASE_AUTH_CONFIG_INVALID",503);}
 if(redirect.protocol!=="https:"&&![ "localhost","127.0.0.1","::1"].includes(redirect.hostname))throw fail("Password recovery redirect must use HTTPS.","SUPABASE_AUTH_CONFIG_INVALID",500);
 if(redirect.username||redirect.password||redirect.search||redirect.hash)throw fail("Password recovery redirect must not contain credentials, query parameters or fragments.","SUPABASE_AUTH_CONFIG_INVALID",500);
 await request({supabaseUrl,publishableKey,path:"/auth/v1/recover?redirect_to="+encodeURIComponent(redirect.toString()),method:"POST",body:{email:normalizedEmail},fetchImpl});
 return {ok:true};
}
export async function updateSupabasePassword({supabaseUrl,publishableKey,accessToken,password,fetchImpl=fetch}){
 const token=String(accessToken||"").trim(),secret=String(password||"");
 if(!token||token.length>8192)throw fail("A valid password-recovery session is required.","RECOVERY_SESSION_REQUIRED",401);
 if(secret.length<12||secret.length>256)throw fail("Use a password with at least 12 characters.","WEAK_PASSWORD",400);
 const payload=await request({supabaseUrl,publishableKey,path:"/auth/v1/user",method:"PUT",accessToken:token,body:{password:secret},fetchImpl});
 if(!payload?.id)throw fail("Identity provider did not confirm the password update.","SUPABASE_AUTH_INVALID_RESPONSE",502);
 return {user:{id:String(payload.id),email:String(payload.email||"")}};
}
export async function refreshSupabaseSession({supabaseUrl,publishableKey,refreshToken,fetchImpl=fetch}){
 if(typeof refreshToken!=="string"||!refreshToken)return null;
 try{return sessionFrom(await request({supabaseUrl,publishableKey,path:"/auth/v1/token?grant_type=refresh_token",method:"POST",body:{refresh_token:refreshToken},fetchImpl}));}
 catch(error){if(error?.status===401||error?.status===400)return null;throw error;}
}
export async function getSupabaseUser({supabaseUrl,publishableKey,accessToken,fetchImpl=fetch}){
 if(!accessToken)return null;
 try{
  const payload=await request({supabaseUrl,publishableKey,path:"/auth/v1/user",accessToken,fetchImpl});
  return payload?.id?{id:String(payload.id),email:String(payload.email||"")}:null;
 }catch(error){if(error?.status===401)return null;throw error;}
}
export async function revokeSupabaseSession({supabaseUrl,publishableKey,accessToken,fetchImpl=fetch}){
 if(!accessToken)return;
 try{await request({supabaseUrl,publishableKey,path:"/auth/v1/logout",method:"POST",accessToken,fetchImpl});}catch{}
}
