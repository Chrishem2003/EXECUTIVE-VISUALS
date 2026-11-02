import test from "node:test";
import assert from "node:assert/strict";
import { extractResearchContent, resolvePublicHttpsUrl } from "../research-import.mjs";

test("extracts article title, author, date and readable body while stripping scripts and navigation",()=>{
 const html='<html><head><title>Wetland &amp; Water Report</title><meta name="author" content="Research Office"><meta property="article:published_time" content="2026-10-20"></head><body><nav>Navigation should disappear</nav><script>secret()</script><article><h1>Wetland observations</h1><p>'+("Field observations document vegetation change and seasonal water variation. ").repeat(3)+'</p></article></body></html>';
 const result=extractResearchContent(html);
 assert.equal(result.title,"Wetland & Water Report");
 assert.equal(result.author,"Research Office");
 assert.equal(result.publishedAt,"2026-10-20");
 assert.match(result.text,/Wetland observations/);
 assert.doesNotMatch(result.text,/Navigation should disappear|secret\(\)/);
});

test("extracts plain text and decodes common HTML entities",()=>{
 const result=extractResearchContent(("A &amp; B report describes field observations and measured environmental changes. ").repeat(3),"text/plain");
 assert.equal(result.title,"Imported research source");
 assert.match(result.text,/A & B report/);
});

test("rejects insecure schemes, local hosts, private IPs and nonstandard ports",async()=>{
 for(const url of ["http://example.org","file:///etc/passwd","https://localhost/report","https://127.0.0.1/report","https://10.0.0.5/report","https://192.168.1.2/report","https://example.org:8443/report","https://user:pass@example.org/report"]){
  await assert.rejects(resolvePublicHttpsUrl(url),error=>["INVALID_RESEARCH_URL","UNSAFE_RESEARCH_URL"].includes(error.code));
 }
});

test("rejects pages without enough readable text",()=>{
 assert.throws(()=>extractResearchContent("<html><script>short</script></html>"),error=>error.code==="RESEARCH_TEXT_EMPTY");
});
