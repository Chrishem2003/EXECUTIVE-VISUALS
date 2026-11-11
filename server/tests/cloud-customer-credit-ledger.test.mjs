import test from "node:test";
import assert from "node:assert/strict";
import { createCloudCustomerCreditLedger } from "../cloud-customer-credit-ledger.mjs";

const base = {
  url: "https://example.supabase.co",
  serviceRoleKey: "service-role-test-secret",
  timeoutMs: 3000
};
const evidence = {
  provider: "runway",
  evidenceType: "provider_task_receipt",
  evidenceId: "task-123",
  evidenceReference: "provider-invoice:task-123"
};

test("settles job-scoped customer credits using service-role schema routing and idempotent evidence", async () => {
  let request;
  const ledger = createCloudCustomerCreditLedger({
    ...base,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify([{ balance: 88, adjustment: 12, replayed: false }]), { status: 200 });
    }
  });
  const result = await ledger.settleJob({
    jobId: "job-123", ownerId: "owner-123", provider: "runway", actualCredits: 18, evidence
  });
  assert.deepEqual(result, { balance: 88, adjustment: 12, replayed: false });
  assert.equal(request.url, "https://example.supabase.co/rest/v1/rpc/settle_generation_credits_for_job");
  assert.equal(request.options.headers["accept-profile"], "executive_visuals");
  assert.equal(request.options.headers.authorization, "Bearer service-role-test-secret");
  assert.equal(request.body.p_actual_credits, 18);
  assert.equal(request.body.p_evidence.evidenceId, "task-123");
});

test("rejects malformed or non-authoritative evidence before network access", async () => {
  let calls = 0;
  const ledger = createCloudCustomerCreditLedger({ ...base, fetchImpl: async () => { calls++; throw new Error("unexpected"); } });
  await assert.rejects(ledger.settleJob({
    jobId: "job-123", ownerId: "owner-123", provider: "runway", actualCredits: 2,
    evidence: { ...evidence, evidenceReference: "" }
  }));
  await assert.rejects(ledger.settleJob({
    jobId: "job-123", ownerId: "owner-123", provider: "runway", actualCredits: 1.5, evidence
  }));
  await assert.rejects(ledger.settleJob({
    jobId: "job-123", ownerId: "owner-123", provider: "fal", actualCredits: 2, evidence
  }));
  assert.equal(calls, 0);
});

test("retries a lost settlement response with the same idempotent provider evidence", async () => {
  let calls = 0;
  const ledger = createCloudCustomerCreditLedger({
    ...base,
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify([{ balance: 88, adjustment: 12, replayed: calls > 1 }]), { status: 200 });
    }
  });
  const args = { jobId: "job-123", ownerId: "owner-123", provider: "runway", actualCredits: 18, evidence };
  assert.equal((await ledger.settleJob(args)).replayed, false);
  assert.equal((await ledger.settleJob(args)).replayed, true);
  assert.equal(calls, 2);
});

test("rejects unexpected database responses and redacts service credentials from errors", async () => {
  const invalid = createCloudCustomerCreditLedger({
    ...base, fetchImpl: async () => new Response("[]", { status: 200 })
  });
  await assert.rejects(invalid.settleJob({
    jobId: "job-123", ownerId: "owner-123", provider: "runway", actualCredits: 1, evidence
  }));
  const denied = createCloudCustomerCreditLedger({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({ message: "bad service-role-test-secret" }), { status: 403 })
  });
  await assert.rejects(
    denied.settleJob({ jobId: "job-123", ownerId: "owner-123", provider: "runway", actualCredits: 1, evidence }),
    error => !error.message.includes("service-role-test-secret")
  );
});
