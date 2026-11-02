import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const commands=[
  {name:"api",command:process.execPath,args:["server/index.mjs"]},
  {name:"web",command:process.platform==="win32"?"cmd":"npm",args:process.platform==="win32"?["/d","/s","/c","npm run dev:web"]:["run","dev:web"]}
];
const children=commands.map(item=>{
  const child=spawn(item.command,item.args,{cwd:root,env:{...process.env},stdio:"inherit",shell:false});
  child.on("exit",(code,signal)=>{if(code!==null&&code!==0)process.stderr.write(item.name+" exited with "+code+"\n");shutdown(code??1);});
  return child;
});
let closing=false;
function shutdown(code=0){if(closing)return;closing=true;for(const child of children)if(child.exitCode===null)child.kill("SIGTERM");setTimeout(()=>process.exit(code),250).unref();}
process.on("SIGINT",()=>shutdown(0));
process.on("SIGTERM",()=>shutdown(0));
