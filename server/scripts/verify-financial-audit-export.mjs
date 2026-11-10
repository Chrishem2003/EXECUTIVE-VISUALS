import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyFinancialAuditExport } from "../financial-audit-export.mjs";

const file=process.argv[2];
if(!file){
 process.stderr.write("Usage: node server/scripts/verify-financial-audit-export.mjs <audit-export.json>\n");
 process.exitCode=2;
}else{
 try{
  const bundle=JSON.parse(await readFile(resolve(file),"utf8"));
  const result=verifyFinancialAuditExport(bundle,{trustedPublicKeyPem:process.env.FINANCIAL_AUDIT_TRUSTED_PUBLIC_KEY||null});
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
  if(!result.valid)process.exitCode=1;
 }catch(error){
  process.stderr.write((error instanceof Error?error.message:"Audit export verification failed.")+"\n");
  process.exitCode=1;
 }
}
