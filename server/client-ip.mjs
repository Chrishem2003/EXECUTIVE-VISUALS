import {isIP} from "node:net";

function normalizeIp(value) {
  if(typeof value!=="string")return "";
  const candidate=value.trim().toLowerCase();
  return isIP(candidate)?candidate:"";
}

export function createClientIpResolver({trustedProxyIps=[]}={}) {
  if(!Array.isArray(trustedProxyIps))throw new Error("Trusted proxy IPs must be an array.");
  const trusted=new Set(trustedProxyIps.map(normalizeIp));
  if(trusted.has(""))throw new Error("Trusted proxy IP list contains an invalid address.");
  return function getClientIp(req) {
    const peer=normalizeIp(req?.socket?.remoteAddress)||"unknown";
    if(peer==="unknown"||!trusted.has(peer))return peer;
    const forwarded=req?.headers?.["x-forwarded-for"];
    if(typeof forwarded!=="string"||!forwarded.trim())return peer;
    const chain=forwarded.split(",").map(normalizeIp);
    if(chain.some(address=>!address))return peer;
    // The trusted edge must append the address it observed as the rightmost
    // value. Never use forwarded data from an untrusted socket peer.
    return chain[chain.length-1];
  };
}
