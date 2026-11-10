import test from "node:test";
import assert from "node:assert/strict";
import { calculateFinancialScenarioIntelligence } from "../financial-scenario-intelligence.mjs";
const fixture = overrides => ({
  currency: "UGX", periodMonth: "2026-11-01", openingCashMinor: 5_000_000,
  monthlyRevenueMinor: 10_000_000, monthlyVariableCostMinor: 4_000_000,
  monthlyFixedCostMinor: 3_000_000, monthlyCapexMinor: 100_000,
  assumptions: { revenueGrowthBps: 200, monthlyChurnBps: 100, collectionRateBps: 9_500, discountRateBps: 100, horizonMonths: 12, sensitivityShockBps: 1_000, evidenceMonths: 12, sourceCoverageBps: 9_500, dataAgeDays: 12 },
  ...overrides
});
test("projects monthly cash, contribution and discounted value", () => {
  const result = calculateFinancialScenarioIntelligence(fixture());
  assert.equal(result.currency, "UGX"); assert.equal(result.base.rows.length, 12);
  assert.equal(result.base.rows[0].revenueMinor, 10_100_000);
  assert.ok(Number.isSafeInteger(result.base.npvCashFlowMinor));
  assert.ok(result.base.endingCashMinor > 5_000_000); assert.equal(result.confidence, "high");
});
test("break-even revenue uses contribution margin and fixed cost", () => {
  const result = calculateFinancialScenarioIntelligence(fixture({ assumptions: { horizonMonths: 1 } }));
  assert.equal(result.base.breakEvenRevenueMinor, 5_000_000); assert.equal(result.base.breakEvenStatus, "above_break_even");
});
test("break-even is unavailable for non-positive contribution margin", () => {
  const result = calculateFinancialScenarioIntelligence(fixture({ monthlyVariableCostMinor: 12_000_000, assumptions: { horizonMonths: 2 } }));
  assert.equal(result.base.breakEvenRevenueMinor, null); assert.equal(result.base.breakEvenStatus, "unavailable_non_positive_contribution_margin");
});
test("opening positive cash reports zero months to positive cash and scenario break-even reflects cost shocks", () => {
  const result = calculateFinancialScenarioIntelligence(fixture());
  assert.equal(result.base.monthsToPositiveCash, 0);
  assert.ok(result.scenarios[0].result.breakEvenRevenueMinor > result.base.breakEvenRevenueMinor);
  assert.ok(result.scenarios[2].result.breakEvenRevenueMinor < result.base.breakEvenRevenueMinor);
});
test("downside, base and upside cases are deterministic and label default shocks", () => {
  const result = calculateFinancialScenarioIntelligence(fixture());
  assert.deepEqual(result.scenarios.map(item => item.id), ["downside", "base", "upside"]);
  assert.equal(result.scenarios[0].basis, "illustrative_default"); assert.equal(result.scenarios[1].basis, "provided_baseline");
  assert.ok(result.scenarios[0].result.npvCashFlowMinor < result.base.npvCashFlowMinor);
  assert.ok(result.scenarios[2].result.npvCashFlowMinor > result.base.npvCashFlowMinor);
});
test("sensitivity ranks the largest one-factor NPV swings", () => {
  const result = calculateFinancialScenarioIntelligence(fixture());
  assert.equal(result.sensitivity.length, 4); assert.ok(result.sensitivity[0].swingMinor >= result.sensitivity[1].swingMinor);
  assert.ok(result.sensitivity.every(item => Number.isSafeInteger(item.swingMinor)));
});
test("decision comparison probability-weights value and subtracts investment", () => {
  const result = calculateFinancialScenarioIntelligence(fixture({ decisions: [
    { name: "Expand acquisition", revenueGrowthBps: 500, oneTimeInvestmentMinor: 500_000, successProbabilityBps: 8_000 },
    { name: "Hold current plan", oneTimeInvestmentMinor: 0, successProbabilityBps: 10_000 }
  ] }));
  assert.equal(result.decisions.length, 2);
  assert.ok(result.decisions[0].probabilityWeightedValueMinor >= result.decisions[1].probabilityWeightedValueMinor);
});
test("confidence requires evidence volume, coverage and freshness", () => {
  const result = calculateFinancialScenarioIntelligence(fixture({ assumptions: { evidenceMonths: 2, sourceCoverageBps: 9_900, dataAgeDays: 2 } }));
  assert.equal(result.confidence, "insufficient_evidence"); assert.equal(result.confidenceBasis.isStatisticalConfidenceInterval, false);
});
test("rejects malformed currency, month, model bounds and negative amounts", () => {
  assert.throws(() => calculateFinancialScenarioIntelligence(fixture({ currency: "US" })), /three-letter/);
  assert.throws(() => calculateFinancialScenarioIntelligence(fixture({ periodMonth: "2026-11-10" })), /first day/);
  assert.throws(() => calculateFinancialScenarioIntelligence(fixture({ assumptions: { horizonMonths: 61 } })), /horizonMonths/);
  assert.throws(() => calculateFinancialScenarioIntelligence(fixture({ monthlyRevenueMinor: -1 })), /monthlyRevenueMinor/);
});
test("keeps all monetary calculations in one currency and discloses source limitations", () => {
  const result = calculateFinancialScenarioIntelligence(fixture());
  assert.equal(result.assumptions.monthlyRevenueMinor, 10_000_000);
  assert.ok(result.limitations.some(item => item.includes("no foreign-exchange conversion")));
  assert.ok(result.limitations.some(item => item.includes("does not independently verify")));
});
