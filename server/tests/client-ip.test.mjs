import test from "node:test";
import assert from "node:assert/strict";
import {createClientIpResolver} from "../client-ip.mjs";

test("ignores spoofed forwarded headers from untrusted peers",()=>{
 const resolve=createClientIpResolver({trustedProxyIps:["10.0.0.10"]});
 assert.equal(resolve({socket:{remoteAddress:"203.0.113.9"},headers:{"x-forwarded-for":"198.51.100.4"}}),"203.0.113.9");
});

test("uses the rightmost validated forwarded address from a trusted proxy",()=>{
 const resolve=createClientIpResolver({trustedProxyIps:["10.0.0.10"]});
 assert.equal(resolve({socket:{remoteAddress:"10.0.0.10"},headers:{"x-forwarded-for":"192.0.2.50, 198.51.100.7"}}),"198.51.100.7");
});

test("falls back to the trusted peer for missing or malformed forwarding headers",()=>{
 const resolve=createClientIpResolver({trustedProxyIps:["10.0.0.10"]});
 assert.equal(resolve({socket:{remoteAddress:"10.0.0.10"},headers:{}}),"10.0.0.10");
 assert.equal(resolve({socket:{remoteAddress:"10.0.0.10"},headers:{"x-forwarded-for":"spoofed"}}),"10.0.0.10");
});

test("rejects invalid trusted proxy configuration",()=>{
 assert.throws(()=>createClientIpResolver({trustedProxyIps:["not-an-ip"]}),/invalid address/);
 assert.throws(()=>createClientIpResolver({trustedProxyIps:"10.0.0.10"}),/array/);
});
