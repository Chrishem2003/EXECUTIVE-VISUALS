import { apiRequest } from "../core/api";

let allowed=false;
let initialization:Promise<boolean>|null=null;

export function isAdminOperationsAllowed():boolean{return allowed;}

export function initializeAdminOperationsCapability():Promise<boolean>{
 if(initialization)return initialization;
 initialization=apiRequest<{capabilities:{admin?:boolean}}>("/api/me")
  .then(result=>{allowed=result.capabilities?.admin===true;return allowed;})
  .catch(()=>{allowed=false;return false;})
  .then(value=>{
   if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("ev:admin-operations-capability"));
   return value;
  });
 return initialization;
}
