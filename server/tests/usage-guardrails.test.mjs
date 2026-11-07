import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { reserveRemoteRequest } from "../usage-guardrails.mjs";
import { ensureBillingSchema,touchBillingAccount,getBillingBalance } from "../billing.mjs";

test("remote usage guardrail reserves requests before dispatch and blocks over-limit calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-remote-usage-"));
  const db = openDatabase(join(root, "usage.sqlite"));
  try {
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("remote-owner", "remote@example.test");
    const remote = { provider: "remote-text", remote: true };
    const local = { provider: "local-text", remote: false };
    assert.deepEqual(reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: local, capability: "text.generate", limit: 1
    }), { reserved: false, reason: "local_provider" });
    const first = reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: remote, capability: "text.generate", limit: 1
    });
    assert.equal(first.reserved, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_usage_reservations WHERE owner_id=?").get("remote-owner").count, 1);
    assert.throws(() => reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: remote, capability: "image.generate", limit: 1
    }), error => error.code === "REMOTE_USAGE_LIMIT_REACHED" && error.limit === 1 && error.used === 1);
    assert.throws(() => reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: remote, capability: "text.generate", limit: 0
    }), error => error.code === "REMOTE_USAGE_LIMIT_REACHED");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote usage guardrail rejects malformed limits and does not count local calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-remote-usage-invalid-"));
  const db = openDatabase(join(root, "usage.sqlite"));
  try {
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("remote-owner", "remote@example.test");
    assert.throws(() => reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: { provider: "remote", remote: true },
      capability: "text.generate", limit: -1
    }), error => error.code === "REMOTE_USAGE_LIMIT_CONFIG_INVALID");
    assert.deepEqual(reserveRemoteRequest(db, {
      ownerId: "remote-owner", provider: { provider: "local", remote: false },
      capability: "text.generate", limit: 0
    }), { reserved: false, reason: "local_provider" });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});


test("billing credits are reserved with remote usage and insufficient balance releases the request slot",async()=>{
  const previousEnabled=process.env.BILLING_ENFORCEMENT_ENABLED;
  const previousDaily=process.env.CREDITS_DAILY_FREE;
  process.env.BILLING_ENFORCEMENT_ENABLED="true";
  process.env.CREDITS_DAILY_FREE="20";
  const root=await mkdtemp(join(tmpdir(),"ev-billing-usage-"));
  const db=openDatabase(join(root,"usage.sqlite"));
  try{
    ensureBillingSchema(db);
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("billing-remote-owner","billing-remote@example.test");
    touchBillingAccount(db,{id:"billing-remote-owner",email:"billing-remote@example.test"});
    const first=reserveRemoteRequest(db,{
      ownerId:"billing-remote-owner",jobId:"job-billing-1",provider:{provider:"remote-image",remote:true},
      capability:"image.generate",limit:10,billingReference:"job-billing-1:run-1:node-1:image.generate"
    });
    assert.equal(first.billingCharge.charged,3);
    assert.equal(getBillingBalance(db,"billing-remote-owner"),17);
    assert.throws(()=>reserveRemoteRequest(db,{
      ownerId:"billing-remote-owner",jobId:"job-billing-1",provider:{provider:"remote-image",remote:true},
      capability:"image.generate",limit:10,billingReference:"job-billing-1:run-1:node-1:image.generate"
    }),error=>error.code==="BILLING_SPEND_ALREADY_RESERVED"&&error.status===409);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_usage_reservations WHERE owner_id=?").get("billing-remote-owner").count,1);
    assert.equal(getBillingBalance(db,"billing-remote-owner"),17);
    process.env.CREDITS_DAILY_FREE="0";
    touchBillingAccount(db,{id:"billing-empty-owner",email:"billing-empty@example.test"});
    assert.throws(()=>reserveRemoteRequest(db,{
      ownerId:"billing-empty-owner",jobId:"job-empty",provider:{provider:"remote-video",remote:true},
      capability:"video.generate",limit:10,billingReference:"job-empty:run-1:node-1:video.generate"
    }),error=>error.code==="BILLING_INSUFFICIENT_CREDITS"&&error.status===402);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_usage_reservations WHERE owner_id=?").get("billing-empty-owner").count,0);
  }finally{
    db.close();await rm(root,{recursive:true,force:true});
    if(previousEnabled===undefined)delete process.env.BILLING_ENFORCEMENT_ENABLED;else process.env.BILLING_ENFORCEMENT_ENABLED=previousEnabled;
    if(previousDaily===undefined)delete process.env.CREDITS_DAILY_FREE;else process.env.CREDITS_DAILY_FREE=previousDaily;
  }
});
