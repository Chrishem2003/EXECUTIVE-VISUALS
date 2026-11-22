import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayTaskReceiptCostResolver } from "../runway-task-receipt-cost-resolver.mjs";

const taskId = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
const resolver = createRunwayTaskReceiptCostResolver();
const context = {
  input: { provider: "runway", model: "gen4.5" },
  task: { status: "succeeded", provider: "runway", model: "gen4.5", taskId, actualCostCredits: 137 },
  providerTaskId: taskId
};

test("converts the exact successful Runway task receipt into realized USD cost and credits", async () => {
  const cost = await resolver(context);
  assert.deepEqual(cost, {
    amount: 1.37,
    currency: "USD",
    actualCredits: 137,
    creditsCharged: 137,
    model: "gen4.5",
    evidenceReference: "runway-task-receipt:" + taskId + ":credits:137"
  });
});

test("rejects missing task receipt cost rather than falling back to estimates", async () => {
  await assert.rejects(
    () => resolver({ ...context, task: { ...context.task, actualCostCredits: undefined, estimatedCostCredits: 137 } }),
    error => error.code === "RUNWAY_TASK_RECEIPT_COST_MISSING"
  );
});

test("rejects mismatched task, provider, model and non-success states", async () => {
  const invalid = [
    { ...context, task: { ...context.task, taskId: "597f6eca-6276-4993-bfeb-53cbbbba6f08" } },
    { ...context, input: { ...context.input, provider: "other" } },
    { ...context, task: { ...context.task, model: "kling_4" } },
    { ...context, task: { ...context.task, status: "running" } },
    { ...context, providerTaskId: "not-a-task-id" }
  ];
  for (const item of invalid) {
    await assert.rejects(
      () => resolver(item),
      error => error.code === "RUNWAY_TASK_RECEIPT_IDENTITY_INVALID"
    );
  }
});

test("rejects zero, fractional, string and unsafe provider credit values", async () => {
  for (const actualCostCredits of [0, -1, 1.5, "137", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => resolver({ ...context, task: { ...context.task, actualCostCredits } }),
      error => error.code === "RUNWAY_TASK_RECEIPT_COST_MISSING"
    );
  }
});
