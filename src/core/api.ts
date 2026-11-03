export interface ApiErrorBody { code?: string; message?: string }
export class ApiError extends Error {
  constructor(public status:number, public code:string, message:string) {
    super(message); this.name="ApiError";
  }
}
let accessToken="";
let refreshInFlight:Promise<boolean>|null=null;
export function setApiAccessToken(token:string){accessToken=token.trim();}
export function clearApiAccessToken(){accessToken="";}
export async function refreshApiSession():Promise<boolean>{
 if(refreshInFlight)return refreshInFlight;
 refreshInFlight=(async()=>{
  try{
   const response=await fetch("/api/auth/session",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"}});
   if(!response.ok){clearApiAccessToken();return false;}
   const payload=await response.json() as {accessToken?:string};
   if(!payload.accessToken){clearApiAccessToken();return false;}
   setApiAccessToken(payload.accessToken);return true;
  }catch{clearApiAccessToken();return false;}
  finally{refreshInFlight=null;}
 })();
 return refreshInFlight;
}
async function sendRequest(path:string,init:RequestInit,token:string){
 const headers=new Headers(init.headers||{});
 if(token)headers.set("authorization","Bearer "+token);else headers.delete("authorization");
 return fetch(path,{...init,headers,credentials:"same-origin"});
}
async function parseResponse<T>(response:Response):Promise<T>{
 if(response.status===204)return {} as T;
 const payload=await response.json().catch(()=>({}));
 if(!response.ok){
  const error=(payload as {error?:ApiErrorBody}).error||{};
  throw new ApiError(response.status,error.code||"REQUEST_FAILED",error.message||"The request could not be completed.");
 }
 return payload as T;
}
export async function apiRequest<T>(path:string,init:RequestInit={}):Promise<T>{
 let response=await sendRequest(path,init,accessToken);
 if(response.status===401&&!path.startsWith("/api/auth/")&&await refreshApiSession())response=await sendRequest(path,init,accessToken);
 if(response.status===401&&!path.startsWith("/api/auth/"))clearApiAccessToken();
 return parseResponse<T>(response);
}
