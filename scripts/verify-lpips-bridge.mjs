import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable=process.env.AI_UPSCALE_LPIPS_PYTHON||process.env.PYTHON||(process.platform==="win32"?"python":"python3");
const bridge=resolve("server/scripts/lpips_assess.py");
const result=spawnSync(executable,["-m","py_compile",bridge],{encoding:"utf8",timeout:30_000,windowsHide:true});
if(result.error?.code==="ENOENT"){
  if(process.env.CI==="true")throw new Error("Python 3 is required in CI to syntax-check the offline LPIPS bridge.");
  console.warn("Python was not found; skipped optional offline LPIPS bridge syntax check.");
}else if(result.error){
  throw result.error;
}else if(result.status!==0){
  throw new Error("Offline LPIPS Python bridge syntax check failed:\n"+(result.stderr||result.stdout||"Python exited with status "+result.status));
}else{
  console.log("Offline LPIPS Python bridge syntax check passed.");
}
