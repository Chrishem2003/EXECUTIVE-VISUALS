export function isRetryableB2PartError(error:unknown):boolean{
 if(!error||typeof error!=="object")return false;
 const candidate=error as {status?:unknown;code?:unknown;name?:unknown};
 const status=Number(candidate.status);
 if(Number.isInteger(status)&&status>0)return status===408||status===425||status===429||(status>=500&&status<=599);
 return candidate.code==="B2_PART_NETWORK_ERROR"||candidate.code==="B2_PART_TIMEOUT"||
  error instanceof TypeError||candidate.name==="NetworkError";
}

export interface RetryB2PartOptions<T>{
 upload:()=>Promise<T>;
 maxAttempts?:number;
 baseDelayMs?:number;
 wait?:(milliseconds:number)=>Promise<void>;
 onRetry?:(attempt:number,error:unknown)=>void;
}

/**
 * Retry one multipart part only for transient transport/provider failures.
 * The caller's upload callback must request a fresh short-lived signed URL
 * on every attempt; validation, auth and cancellation failures are terminal.
 */
export async function retryB2PartUpload<T>({
 upload,maxAttempts=3,baseDelayMs=350,
 wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds)),
 onRetry
}:RetryB2PartOptions<T>):Promise<T>{
 const attempts=Math.max(1,Math.min(5,Math.floor(maxAttempts)));
 const delayBase=Math.max(0,Math.min(5000,Math.floor(baseDelayMs)));
 for(let attempt=1;attempt<=attempts;attempt++){
  try{return await upload();}
  catch(error){
   if(!isRetryableB2PartError(error)||attempt>=attempts)throw error;
   onRetry?.(attempt,error);
   await wait(Math.min(5000,delayBase*(2**(attempt-1))));
  }
 }
 throw new Error("B2 part retry limit was reached.");
}
