export interface ApiErrorBody { code?: string; message?: string }
export class ApiError extends Error {
  constructor(public status:number, public code:string, message:string) {
    super(message); this.name="ApiError";
  }
}

async function request<T>(path:string,init:RequestInit={},bearerToken?:string):Promise<T>{
  const headers=new Headers(init.headers||{});
  if(bearerToken)headers.set("authorization","Bearer "+bearerToken);
  const response=await fetch(path,{...init,headers,credentials:"same-origin"});
  if(response.status===204)return {} as T;
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=(payload as {error?:ApiErrorBody}).error||{};
    throw new ApiError(response.status,error.code||"REQUEST_FAILED",error.message||"The request could not be completed.");
  }
  return payload as T;
}

export function apiRequest<T>(path:string,init:RequestInit={}):Promise<T>{return request<T>(path,init);}

/** Explicit one-time bearer use is reserved for Supabase email-recovery tokens. */
export function apiRequestWithBearer<T>(path:string,token:string,init:RequestInit={}):Promise<T>{
  if(!token||token.length>8192)throw new ApiError(401,"RECOVERY_SESSION_REQUIRED","A valid recovery session is required.");
  return request<T>(path,init,token);
}

/** Fetch private media using the same-origin HttpOnly session cookie. */
export async function apiRequestBlob(path:string,init:RequestInit={}):Promise<Blob>{
  const response=await fetch(path,{...init,headers:new Headers(init.headers||{}),credentials:"same-origin"});
  if(!response.ok){
    const payload=await response.json().catch(()=>({}));
    const error=(payload as {error?:ApiErrorBody}).error||{};
    throw new ApiError(response.status,error.code||"REQUEST_FAILED",error.message||"The media asset could not be loaded.");
  }
  return response.blob();
}