export interface ApiErrorBody { code?: string; message?: string }
export class ApiError extends Error {
  constructor(public status:number, public code:string, message:string) {
    super(message); this.name="ApiError";
  }
}
let accessToken="";
export function setApiAccessToken(token:string){accessToken=token.trim();}
export function clearApiAccessToken(){accessToken="";}

function csrfCookieToken():string {
  if(typeof document==="undefined")return "";
  const entry=document.cookie.split(";").map(part=>part.trim()).find(part=>part.startsWith("ev_csrf="));
  const token=entry?.slice("ev_csrf=".length)||"";
  return /^[A-Za-z0-9_-]{43}$/.test(token)?token:"";
}

export async function apiRequest<T>(path:string,init:RequestInit={}):Promise<T>{
  const headers=new Headers(init.headers||{});
  if(accessToken)headers.set("authorization","Bearer "+accessToken);
  const method=(init.method||"GET").toUpperCase();
  if(!["GET","HEAD","OPTIONS"].includes(method)){
    const csrfToken=csrfCookieToken();
    if(csrfToken)headers.set("x-csrf-token",csrfToken);
  }
  const response=await fetch(path,{...init,headers,credentials:"same-origin"});
  if(response.status===204)return {} as T;
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=(payload as {error?:ApiErrorBody}).error||{};
    throw new ApiError(response.status,error.code||"REQUEST_FAILED",error.message||"The request could not be completed.");
  }
  return payload as T;
}
