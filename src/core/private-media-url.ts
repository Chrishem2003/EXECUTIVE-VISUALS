export interface PrivateMediaUrl {url:string;expiresAt:number}
/** Validate a short-lived signed media URL before keeping it in the browser's memory cache. */
export function validatePrivateMediaUrl(value:string,baseUrl:string,expiresIn:number,now=Date.now()):PrivateMediaUrl{
 if(typeof value!=="string"||!value.trim())throw new Error("Cloud media URL is missing.");
 if(!Number.isInteger(expiresIn)||expiresIn<60||expiresIn>3600)throw new Error("Cloud media URL expiry is invalid.");
 let url:URL;
 try{url=new URL(value,baseUrl);}catch{throw new Error("Cloud media URL is invalid.");}
 if(url.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(url.hostname))throw new Error("Cloud media URL must use HTTPS.");
 if(url.username||url.password||url.hash)throw new Error("Cloud media URL contains unsafe URL components.");
 return {url:url.href,expiresAt:now+Math.max(30,expiresIn-30)*1000};
}
