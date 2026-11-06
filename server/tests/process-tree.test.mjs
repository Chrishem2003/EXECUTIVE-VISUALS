import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProcessSpawnOptions, signalNativeProcessTree } from "../process-tree.mjs";

test("native process group cancellation also terminates helper descendants on POSIX", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-process-tree-"));
  const pidFile = join(directory, "pids");
  const childScript = [
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    'const grandchild = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'fs.writeFileSync(' + JSON.stringify(pidFile) + ', process.pid + "\\n" + grandchild.pid);',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);'
  ].join("\n");
  const parent = spawn(process.execPath, ["-e", childScript], nativeProcessSpawnOptions({ stdio: "ignore" }));
  try {
    let pids = "";
    for (let attempt = 0; attempt < 100 && !pids; attempt++) {
      try { pids = await readFile(pidFile, "utf8"); } catch {}
      if (!pids) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const [parentPid, childPid] = pids.trim().split("\n").map(Number);
    assert.ok(parentPid > 0 && childPid > 0, "both native process levels should start");
    assert.equal(signalNativeProcessTree(parent, "SIGTERM"), true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(signalNativeProcessTree(parent, "SIGKILL"), true);
    await new Promise(resolve => parent.once("close", resolve));
    for (const pid of [parentPid, childPid]) {
      assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH",
        "all processes in the native tool group should be terminated");
    }
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { signalNativeProcessTree(parent, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});
