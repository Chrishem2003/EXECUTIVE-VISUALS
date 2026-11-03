const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function safeRedirect(value){
 if(!value)return undefined;
 let parsed;try{parsed=new URL(value);}catch{throw new Error("Authentication redirect URL must be an absolute HTTPS URL.");}
 if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.hash)throw new Error("Authentication redirect URL must be a safe HTTPS URL.");
 return parsed.toString();
}
export function createSupabaseAuth({url=process.env.SUPABASE_URL,publishableKey=process.env.SUPABASE_PUBLISHABLE_KEY,fetchImpl=globalThis.fetch,redirectUrl=process.env.SUPABASE_AUTH_REDIRECT_URL||process.env.PUBLIC_APP_URL,timeoutMs=10000}={}){
 if(!url||!publishableKey)throw new Error("Supabase authentication requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.");
 if(typeof fetchImpl!=="function")throw new Error("Supabase authentication requires fetch.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw new Error("Supabase authentication timeout is invalid.");
 let base;try{const parsed=new URL(url);if(parsed.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(parsed.hostname)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error();base=parsed.origin;}catch{throw new Error("Supabase authentication URL must be a safe absolute HTTPS URL.");}
 const redirect=safeRedirect(redirectUrl);
 async function request(path,{method="POST",body,accessToken}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetchImpl(base+"/auth/v1/"+path,{method,headers:{apikey:publishableKey,accept:"application/json","content-type":"application/json",...(accessToken?{authorization:"Bearer "+accessToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   const raw=await response.text();let data={};if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Identity provider returned an invalid response.");}}
   if(!response.ok){const error=new Error(String(data.msg||data.message||data.error_description||"Authentication could not be completed.").slice(0,300));error.status=response.status;error.code=String(data.code||data.error_code||"AUTH_PROVIDER_REJECTED");throw error;}
   return data;
  }catch(error){if(error?.name==="AbortError"){const timeout=new Error("Identity provider request timed out.");timeout.code="AUTH_PROVIDER_TIMEOUT";throw timeout;}throw error;}
  finally{clearTimeout(timer);}
 }
 function session(data){
  if(!data?.access_token||!data?.refresh_token||!data?.user?.id)throw new Error("Identity provider did not return a complete authenticated session.");
  return {accessToken:data.access_token,refreshToken:data.refresh_token,expiresIn:Number.isFinite(data.expires_in)?data.expires_in:3600,user:{id:data.user.id,email:data.user.email||"",emailVerified:Boolean(data.user.email_confirmed_at)}};
 }
 return Object.freeze({
  async getUser(accessToken){if(typeof accessToken!=="string"||accessToken.length<20||accessToken.length>8192)throw Object.assign(new Error("A valid access token is required."),{status:401,code:"INVALID_ACCESS_TOKEN"});const data=await request("user",{method:"GET",accessToken});if(!data?.id)throw Object.assign(new Error("Identity provider did not return a valid user."),{status:401,code:"INVALID_ACCESS_TOKEN"});return {id:data.id,email:data.email||"",emailVerified:Boolean(data.email_confirmed_at)};},
  async signInWithPassword({email,password}){if(!EMAIL.test(String(email||"").trim())||typeof password!=="string"||!password.length||password.length>256)throw Object.assign(new Error("Enter a valid email and password."),{status:400,code:"INVALID_CREDENTIALS"});return session(await request("token?grant_type=password",{body:{email:String(email).trim().toLowerCase(),password}}));},
  async signUp({email,password}){if(!EMAIL.test(String(email||"").trim())||typeof password!=="string"||password.length<12||password.length>256)throw Object.assign(new Error("Enter a valid email and a password of at least 12 characters."),{status:400,code:"INVALID_CREDENTIALS"});const path="signup"+(redirect?"?redirect_to="+encodeURIComponent(redirect):"");const data=await request(path,{body:{email:String(email).trim().toLowerCase(),password}});if(data.access_token&&data.refresh_token)return {confirmationRequired:false,...session(data)};return {confirmationRequired:true,user:data.user?.id?{id:data.user.id,email:data.user.email||""}:null};},
  async refreshSession(refreshToken){if(typeof refreshToken!=="string"||refreshToken.length<20||refreshToken.length>4096)throw Object.assign(new Error("The sign-in session has expired. Please sign in again."),{status:401,code:"SESSION_EXPIRED"});return session(await request("token?grant_type=refresh_token",{body:{refresh_token:refreshToken}}));},
  async updatePassword(accessToken,password){if(typeof accessToken!=="string"||accessToken.length<20||typeof password!=="string"||password.length<12||password.length>256)throw Object.assign(new Error("Provide a valid recovery session and a password of at least 12 characters."),{status:400,code:"INVALID_PASSWORD_UPDATE"});const data=await request("user",{method:"PUT",accessToken,body:{password}});return {user:{id:data.id,email:data.email||""}};},
  async recover({email}){if(!EMAIL.test(String(email||"").trim()))throw Object.assign(new Error("Enter a valid email address."),{status:400,code:"INVALID_EMAIL"});const path="recover"+(redirect?"?redirect_to="+encodeURIComponent(redirect):"");await request(path,{body:{email:String(email).trim().toLowerCase()}});return {accepted:true};},
  async signOut(accessToken){if(!accessToken)return {ok:true};await request("logout",{accessToken});return {ok:true};}
 });
}
