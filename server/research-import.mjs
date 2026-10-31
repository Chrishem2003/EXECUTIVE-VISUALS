import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

const MAX_BYTES=2*1024*1024;
const MAX_TEXT=12000;
const TIMEOUT_MS=12000;
const blockedV4=(ip)=>{
 const p=ip.split(".").map(Number),a=p[0],b=p[1],c=p[2];
 return a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113;
};
const blockedV6=(ip)=>{
 const value=ip.toLowerCase().split("%")[0];
 return value==="::"||value==="::1"||value.startsWith("fc")||value.startsWith("fd")||value.startsWith("fe8")||value.startsWith("fe9")||value.startsWith("fea")||value.startsWith("feb")||value.startsWith("ff")||value.startsWith("::ffff:");
};
export async function resolvePublicHttpsUrl(value){
 let url;try{url=new URL(String(value||""));}catch{throw Object.assign(new Error("Enter a valid HTTPS source URL."),{code:"INVALID_RESEARCH_URL",status:400});}
 if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443")throw Object.assign(new Error("Research import accepts public HTTPS URLs on the standard port only."),{code:"UNSAFE_RESEARCH_URL",status:400});
 if(!url.hostname||url.hostname==="localhost"||url.hostname.endsWith(".localhost")||url.hostname.endsWith(".local"))throw Object.assign(new Error("Local and private network addresses cannot be imported."),{code:"UNSAFE_RESEARCH_URL"});
 const family=isIP(url.hostname);
 let addresses;
 try{addresses=family?[{address:url.hostname,family}]:await lookup(url.hostname,{all:true,verbatim:true});}catch{throw Object.assign(new Error("The source host could not be resolved."),{code:"RESEARCH_HOST_UNAVAILABLE",status:422});}
 if(!addresses.length||addresses.some(item=>item.family===4?blockedV4(item.address):item.family===6?blockedV6(item.address):true))throw Object.assign(new Error("The source host resolves to a private or reserved network address."),{code:"UNSAFE_RESEARCH_URL"});
 return {url,addresses};
}
function requestPinned(url,addresses){
 return new Promise((resolve,reject)=>{
  const address=addresses[0];
  const req=httpsRequest({protocol:"https:",hostname:url.hostname,port:443,path:url.pathname+url.search,method:"GET",headers:{"user-agent":"ExecutiveVisualsResearchBot/1.0 (+source extraction; respects HTTP status and size limits)","accept":"text/html,application/xhtml+xml,text/plain;q=0.9","accept-encoding":"identity"},lookup:(_host,_options,callback)=>callback(null,address.address,address.family),servername:url.hostname,timeout:TIMEOUT_MS},res=>{
   const status=res.statusCode||0;
   if([301,302,303,307,308].includes(status)){res.resume();resolve({redirect:res.headers.location,status});return;}
   if(status<200||status>=300){res.resume();reject(Object.assign(new Error("The source returned HTTP "+status+"."),{code:"RESEARCH_HTTP_ERROR",status:502}));return;}
   const type=String(res.headers["content-type"]||"").split(";")[0].trim().toLowerCase();
   if(!["text/html","application/xhtml+xml","text/plain"].includes(type)){res.resume();reject(Object.assign(new Error("Only HTML and plain-text sources can currently be extracted."),{code:"UNSUPPORTED_RESEARCH_CONTENT",status:415}));return;}
   const declared=Number(res.headers["content-length"]||0);
   if(declared>MAX_BYTES){res.destroy();reject(Object.assign(new Error("The source is larger than the 2 MB extraction limit."),{code:"RESEARCH_SOURCE_TOO_LARGE",status:413}));return;}
   const chunks=[];let size=0;
   res.on("data",chunk=>{size+=chunk.length;if(size>MAX_BYTES){res.destroy(Object.assign(new Error("The source is larger than the 2 MB extraction limit."),{code:"RESEARCH_SOURCE_TOO_LARGE"}));return;}chunks.push(chunk);});
   res.on("end",()=>resolve({type,body:Buffer.concat(chunks).toString("utf8")}));
   res.on("error",reject);
  });
  req.on("timeout",()=>req.destroy(Object.assign(new Error("The source request timed out."),{code:"RESEARCH_TIMEOUT",status:504})));
  req.on("error",reject);req.end();
 });
}
const decodeEntities=value=>String(value).replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n)))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(n,16))));
export function extractResearchContent(body,type="text/html"){
 const source=String(body||"");
 const meta=(name)=>{
  for(const tag of source.match(/<meta\b[^>]*>/gi)||[]){
   const attrs=Object.fromEntries([...tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(match=>[match[1].toLowerCase(),match[2]??match[3]??match[4]??""]));
   if(String(attrs.name||attrs.property||"").toLowerCase()===name.toLowerCase()&&attrs.content)return decodeEntities(attrs.content);
  }
  return "";
 };
 const title=type==="text/plain"?"Imported research source":decodeEntities((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||meta("og:title")||meta("twitter:title")).replace(/\s+/g," ").trim().slice(0,240);
 const author=meta("author")||meta("article:author")||"";
 const publishedAt=meta("article:published_time")||meta("date")||"";
 const cleaned=type==="text/plain"?source:source.replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi," ").replace(/<!--[\s\S]*?-->/g," ").replace(/<(br|p|div|li|h[1-6]|article|section|tr)\b[^>]*>/gi,"\n").replace(/<[^>]+>/g," ");
 const text=decodeEntities(cleaned).replace(/[\t\r ]+/g," ").replace(/ *\n */g,"\n").replace(/\n{3,}/g,"\n\n").trim().slice(0,MAX_TEXT);
 if(text.length<80)throw Object.assign(new Error("The page did not contain enough readable text to create a research record."),{code:"RESEARCH_TEXT_EMPTY",status:422});
 return {title:title||"Imported research source",author,publishedAt,text};
}
export async function importResearchUrl(value){
 let current=String(value||"");
 for(let redirects=0;redirects<=3;redirects++){
  const {url,addresses}=await resolvePublicHttpsUrl(current);
  const response=await requestPinned(url,addresses);
  if(!response.redirect)return {...extractResearchContent(response.body,response.type),url:url.toString(),contentType:response.type,fetchedAt:new Date().toISOString(),characterCount:response.body.length};
  if(redirects===3)throw Object.assign(new Error("The source redirected too many times."),{code:"RESEARCH_REDIRECT_LIMIT",status:422});
  current=new URL(response.redirect,url).toString();
 }
 throw Object.assign(new Error("The source could not be imported."),{code:"RESEARCH_IMPORT_FAILED",status:422});
}
