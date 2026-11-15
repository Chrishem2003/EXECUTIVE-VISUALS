import test from "node:test";
import assert from "node:assert/strict";
import { createLumaActualCostResolver } from "../luma-actual-cost-resolver.mjs";

const id = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e";
const task = {
  taskId: id, providerGenerationId: id,
  usage: { credits_charged: 100 }
};

test("converts Luma settled credits using an explicit account rate", async () => {
  const resolve = createLumaActualCostResolver({ usdPerCredit: "0.003" });
  const cost = await resolve({ providerTaskId: id, task, model: "ray-3.2" });
  assert.equal(cost.amount, 0.3);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.creditsCharged, 100);
  assert.equal(cost.evidenceReference, "luma-generation-usage:" + id + ":100credits@0.003USD");
});

test("does not treat unsettled, unavailable or null Luma usage as zero cost", async () => {
  const resolve = createLumaActualCostResolver({ usdPerCredit: "0.003" });
  for (const usage of [null, {}, { credits_charged: null }, { credits_charged: "0" }]) {
    await assert.rejects(resolve({
      providerTaskId: id, model: "ray-3.2", task: { ...task, usage, providerGenerationId: id }
    }), error => error.code === "LUMA_BILLING_NOT_SETTLED");
  }
  const zero = await resolve({
    providerTaskId: id, model: "ray-3.2",
    task: { ...task, usage: { credits_charged: 0 } }
  });
  assert.equal(zero.amount, 0);
});

test("requires an explicit positive account rate and exact generation identity", async () => {
  for (const value of [undefined, "", "0", "-0.1", "0.003usd", "1e-3"]) {
    assert.throws(() => createLumaActualCostResolver({ usdPerCredit: value }), error => error.code === "LUMA_BILLING_RATE_REQUIRED");
  }
  const resolve = createLumaActualCostResolver({ usdPerCredit: "0.003" });
  await assert.rejects(resolve({ providerTaskId: id, model: "wrong", task }), error => error.code === "LUMA_BILLING_INPUT_INVALID");
  await assert.rejects(resolve({ providerTaskId: "not-a-uuid", model: "ray-3.2", task }), error => error.code === "LUMA_BILLING_INPUT_INVALID");
});
