import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable=process.env.FLASHVSR_PYTHON||(process.platform==="win32"?"python":"python3");
const script=resolve("server/scripts/flashvsr-infer.py");
const result=spawnSync(executable,["-m","py_compile",script],{encoding:"utf8",timeout:30_000,windowsHide:true});
if(result.error?.code==="ENOENT"){
  if(process.env.CI==="true")throw new Error("Python 3 is required in CI to syntax-check the FlashVSR bridge.");
  console.warn("Python was not found; skipped optional FlashVSR bridge syntax check.");
}else if(result.error){
  throw result.error;
}else if(result.status!==0){
  throw new Error("FlashVSR Python bridge syntax check failed:\n"+(result.stderr||result.stdout||"Python exited with status "+result.status));
}else{
  console.log("FlashVSR Python bridge syntax check passed.");
}
