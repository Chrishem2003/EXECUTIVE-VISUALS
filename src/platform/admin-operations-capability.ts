let allowed=false;
let initialization:Promise<boolean>|null=null;

export function isAdminOperationsAllowed():boolean{return allowed;}

export function initializeAdminOperationsCapability():Promise<boolean>{
 if(initialization)return initialization;
 initialization=fetch("/api/me",{credentials:"same-origin"})
  .then(async response=>{
   if(!response.ok)throw new Error("Administrator capability could not be verified.");
   const result=await response.json() as {capabilities?:{admin?:boolean}};
   allowed=result.capabilities?.admin===true;
   return allowed;
  })
  .catch(()=>{allowed=false;return false;})
  .then(value=>{
   if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("ev:admin-operations-capability"));
   return value;
  });
 return initialization;
}
