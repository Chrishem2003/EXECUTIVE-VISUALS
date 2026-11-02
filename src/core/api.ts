export interface ApiErrorBody { code?: string; message?: string }
export class ApiError extends Error {
  constructor(public status:number, public code:string, message:string) {
    super(message); this.name="ApiError";
  }
}
let accessToken="";
export function setApiAccessToken(token:string){accessToken=token.trim();}
export function clearApiAccessToken(){accessToken="";}

export async function apiRequest<T>(path:string,init:RequestInit={}):Promise<T>{
  const headers=new Headers(init.headers||{});
  if(accessToken)headers.set("authorization","Bearer "+accessToken);
  const response=await fetch(path,{...init,headers,credentials:"same-origin"});
  if(response.status===204)return {} as T;
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=(payload as {error?:ApiErrorBody}).error||{};
    throw new ApiError(response.status,error.code||"REQUEST_FAILED",error.message||"The request could not be completed.");
  }
  return payload as T;
}
