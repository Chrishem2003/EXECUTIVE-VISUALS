const BPS = 10_000;
const safeInt = (value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(name + " must be a safe integer between " + min + " and " + max + ".");
  return value;
};
const amount = (value, name) => safeInt(value, name, { min: 0 });
const bps = (value, name, max = 10_000) => safeInt(value, name, { min: -10_000, max });
const roundMinor = value => {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded)) throw new RangeError("Projected amount exceeds safe integer range.");
  return rounded;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Scenario input must be an object.");
  const currency = String(input.currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError("currency must be a three-letter ISO currency code.");
  const periodMonth = String(input.periodMonth || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(periodMonth) || Number.isNaN(Date.parse(periodMonth + "T00:00:00Z"))) throw new TypeError("periodMonth must be the first day of a valid month (YYYY-MM-01).");
  const assumptions = input.assumptions || {};
  const normalized = {
    currency, periodMonth,
    openingCashMinor: amount(input.openingCashMinor ?? 0, "openingCashMinor"),
    monthlyRevenueMinor: amount(input.monthlyRevenueMinor, "monthlyRevenueMinor"),
    monthlyVariableCostMinor: amount(input.monthlyVariableCostMinor, "monthlyVariableCostMinor"),
    monthlyFixedCostMinor: amount(input.monthlyFixedCostMinor, "monthlyFixedCostMinor"),
    monthlyCapexMinor: amount(input.monthlyCapexMinor ?? 0, "monthlyCapexMinor"),
    monthlyNewRevenueMinor: amount(input.monthlyNewRevenueMinor ?? 0, "monthlyNewRevenueMinor"),
    assumptions: {
      revenueGrowthBps: bps(assumptions.revenueGrowthBps ?? 0, "revenueGrowthBps", 5_000),
      monthlyChurnBps: safeInt(assumptions.monthlyChurnBps ?? 0, "monthlyChurnBps", { min: 0, max: 10_000 }),
      variableCostRateChangeBps: bps(assumptions.variableCostRateChangeBps ?? 0, "variableCostRateChangeBps", 10_000),
      fixedCostGrowthBps: bps(assumptions.fixedCostGrowthBps ?? 0, "fixedCostGrowthBps", 5_000),
      collectionRateBps: safeInt(assumptions.collectionRateBps ?? 10_000, "collectionRateBps", { min: 0, max: 10_000 }),
      discountRateBps: safeInt(assumptions.discountRateBps ?? 100, "discountRateBps", { min: 0, max: 5_000 }),
      horizonMonths: safeInt(assumptions.horizonMonths ?? 12, "horizonMonths", { min: 1, max: 60 }),
      sensitivityShockBps: safeInt(assumptions.sensitivityShockBps ?? 1_000, "sensitivityShockBps", { min: 1, max: 5_000 }),
      evidenceMonths: safeInt(assumptions.evidenceMonths ?? 0, "evidenceMonths", { min: 0, max: 60 }),
      sourceCoverageBps: safeInt(assumptions.sourceCoverageBps ?? 0, "sourceCoverageBps", { min: 0, max: 10_000 }),
      dataAgeDays: safeInt(assumptions.dataAgeDays ?? 999, "dataAgeDays", { min: 0, max: 3_650 })
    }
  };
  if (normalized.monthlyVariableCostMinor > 0 && normalized.monthlyRevenueMinor === 0) throw new TypeError("monthlyRevenueMinor must be positive when variable costs are supplied.");
  const decisions = input.decisions ?? [];
  if (!Array.isArray(decisions) || decisions.length > 10) throw new TypeError("decisions must be an array with no more than 10 options.");
  normalized.decisions = decisions.map((option, index) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) throw new TypeError("Decision " + index + " must be an object.");
    const name = String(option.name || "").trim();
    if (!name || name.length > 100) throw new TypeError("Decision " + index + " needs a name of 1–100 characters.");
    return {
      name,
      revenueGrowthBps: bps(option.revenueGrowthBps ?? 0, "decision revenueGrowthBps", 5_000),
      variableCostRateChangeBps: bps(option.variableCostRateChangeBps ?? 0, "decision variableCostRateChangeBps", 10_000),
      fixedCostGrowthBps: bps(option.fixedCostGrowthBps ?? 0, "decision fixedCostGrowthBps", 5_000),
      churnDeltaBps: safeInt(option.churnDeltaBps ?? 0, "decision churnDeltaBps", { min: -5_000, max: 5_000 }),
      oneTimeInvestmentMinor: amount(option.oneTimeInvestmentMinor ?? 0, "oneTimeInvestmentMinor"),
      successProbabilityBps: safeInt(option.successProbabilityBps ?? 10_000, "successProbabilityBps", { min: 0, max: 10_000 })
    };
  });
  return normalized;
}

function project(input, adjustment = {}) {
  const a = input.assumptions;
  const growth = clamp(a.revenueGrowthBps + (adjustment.revenueGrowthBps || 0), -10_000, 5_000) / BPS;
  const churn = clamp(a.monthlyChurnBps + (adjustment.churnDeltaBps || 0), 0, 10_000) / BPS;
  const variableRate = input.monthlyRevenueMinor > 0
    ? input.monthlyVariableCostMinor / input.monthlyRevenueMinor * (1 + (a.variableCostRateChangeBps + (adjustment.variableCostRateChangeBps || 0)) / BPS)
    : 0;
  const fixedGrowth = clamp(a.fixedCostGrowthBps + (adjustment.fixedCostGrowthBps || 0), -10_000, 5_000) / BPS;
  const discount = a.discountRateBps / BPS;
  let revenue = input.monthlyRevenueMinor, fixed = input.monthlyFixedCostMinor, cash = input.openingCashMinor, npv = 0;
  const rows = [];
  for (let month = 1; month <= a.horizonMonths; month++) {
    revenue = Math.max(0, revenue * (1 + growth - churn) + input.monthlyNewRevenueMinor);
    const variable = Math.max(0, revenue * variableRate);
    if (month > 1) fixed = Math.max(0, fixed * (1 + fixedGrowth));
    const collected = revenue * (a.collectionRateBps / BPS);
    const operatingContribution = revenue - variable - fixed;
    const netCashFlow = collected - variable - fixed - input.monthlyCapexMinor;
    cash += netCashFlow;
    npv += operatingContribution / Math.pow(1 + discount, month);
    rows.push({ month, revenueMinor: roundMinor(revenue), variableCostMinor: roundMinor(variable), fixedCostMinor: roundMinor(fixed), collectedRevenueMinor: roundMinor(collected), operatingContributionMinor: roundMinor(operatingContribution), capexMinor: input.monthlyCapexMinor, netCashFlowMinor: roundMinor(netCashFlow), closingCashMinor: roundMinor(cash) });
  }
  const contributionMargin = input.monthlyRevenueMinor > 0 ? 1 - input.monthlyVariableCostMinor / input.monthlyRevenueMinor * (1 + a.variableCostRateChangeBps / BPS) : 0;
  const breakEvenRevenue = contributionMargin > 0 ? input.monthlyFixedCostMinor / contributionMargin : null;
  const first = rows[0] || null;
  return {
    currency: input.currency, horizonMonths: a.horizonMonths,
    npvContributionMinor: roundMinor(npv),
    totalOperatingContributionMinor: roundMinor(rows.reduce((sum, row) => sum + row.operatingContributionMinor, 0)),
    endingCashMinor: roundMinor(cash),
    minimumClosingCashMinor: roundMinor(Math.min(input.openingCashMinor, ...rows.map(row => row.closingCashMinor))),
    breakEvenRevenueMinor: breakEvenRevenue === null ? null : roundMinor(breakEvenRevenue),
    breakEvenGapMinor: breakEvenRevenue === null || !first ? null : roundMinor(first.revenueMinor - breakEvenRevenue),
    breakEvenStatus: breakEvenRevenue === null ? "unavailable_non_positive_contribution_margin" : first.revenueMinor >= breakEvenRevenue ? "above_break_even" : "below_break_even",
    monthsToPositiveCash: rows.find(row => row.closingCashMinor > 0)?.month ?? null, rows
  };
}
function confidenceFor(a) {
  if (a.evidenceMonths >= 12 && a.sourceCoverageBps >= 9_000 && a.dataAgeDays <= 35) return "high";
  if (a.evidenceMonths >= 6 && a.sourceCoverageBps >= 7_500 && a.dataAgeDays <= 60) return "moderate";
  if (a.evidenceMonths >= 3 && a.sourceCoverageBps >= 5_000 && a.dataAgeDays <= 90) return "low";
  return "insufficient_evidence";
}
export function calculateFinancialScenarioIntelligence(rawInput) {
  const input = validateInput(rawInput), base = project(input);
  const scenarios = [
    { id: "downside", label: "Downside", adjustment: { revenueGrowthBps: -1_000, variableCostRateChangeBps: 1_000, fixedCostGrowthBps: 500, churnDeltaBps: 500 }, basis: "illustrative_default" },
    { id: "base", label: "Base", adjustment: {}, basis: "provided_baseline" },
    { id: "upside", label: "Upside", adjustment: { revenueGrowthBps: 1_000, variableCostRateChangeBps: -500, fixedCostGrowthBps: -250, churnDeltaBps: -250 }, basis: "illustrative_default" }
  ].map(item => ({ ...item, result: project(input, item.adjustment) }));
  const shock = input.assumptions.sensitivityShockBps;
  const sensitivity = [
    ["revenueGrowthBps", "Revenue growth", { revenueGrowthBps: shock }, { revenueGrowthBps: -shock }],
    ["variableCostRateChangeBps", "Variable-cost rate", { variableCostRateChangeBps: -shock }, { variableCostRateChangeBps: shock }],
    ["fixedCostGrowthBps", "Fixed-cost growth", { fixedCostGrowthBps: -shock }, { fixedCostGrowthBps: shock }],
    ["churnDeltaBps", "Monthly churn", { churnDeltaBps: -shock }, { churnDeltaBps: shock }]
  ].map(([key, label, favorable, adverse]) => {
    const high = project(input, favorable).npvContributionMinor, low = project(input, adverse).npvContributionMinor;
    return { key, label, favorableNpvMinor: high, adverseNpvMinor: low, favorableDeltaMinor: high - base.npvContributionMinor, adverseDeltaMinor: low - base.npvContributionMinor, swingMinor: roundMinor(Math.abs(high - low)) };
  }).sort((left, right) => right.swingMinor - left.swingMinor);
  const decisions = input.decisions.map(option => {
    const result = project(input, option);
    const expectedNpv = result.npvContributionMinor * option.successProbabilityBps / BPS - option.oneTimeInvestmentMinor;
    return { name: option.name, npvContributionMinor: result.npvContributionMinor, oneTimeInvestmentMinor: option.oneTimeInvestmentMinor, successProbabilityBps: option.successProbabilityBps, probabilityWeightedValueMinor: roundMinor(expectedNpv), incrementalValueVsBaseMinor: roundMinor(expectedNpv - base.npvContributionMinor), endingCashMinor: roundMinor(result.endingCashMinor - option.oneTimeInvestmentMinor) };
  }).sort((left, right) => right.probabilityWeightedValueMinor - left.probabilityWeightedValueMinor);
  const confidence = confidenceFor(input.assumptions);
  return {
    generatedAt: new Date().toISOString(), periodMonth: input.periodMonth, currency: input.currency,
    model: "deterministic_monthly_scenario_v1", confidence,
    confidenceBasis: { evidenceMonths: input.assumptions.evidenceMonths, sourceCoverageBps: input.assumptions.sourceCoverageBps, dataAgeDays: input.assumptions.dataAgeDays, isStatisticalConfidenceInterval: false },
    base, scenarios, sensitivity, decisions,
    assumptions: { ...input.assumptions, scenarioDefaultsAreIllustrative: true, openingCashMinor: input.openingCashMinor, monthlyRevenueMinor: input.monthlyRevenueMinor, monthlyVariableCostMinor: input.monthlyVariableCostMinor, monthlyFixedCostMinor: input.monthlyFixedCostMinor, monthlyCapexMinor: input.monthlyCapexMinor, monthlyNewRevenueMinor: input.monthlyNewRevenueMinor },
    limitations: [
      "Scenario outputs are deterministic management models, not guaranteed forecasts or audited financial statements.",
      "Downside and upside shocks are illustrative defaults; replace them with approved assumptions before using them for decisions.",
      "Evidence confidence is an evidence-coverage label, not a statistical confidence interval.",
      "All monetary inputs and outputs remain in the selected currency; no foreign-exchange conversion or cross-currency aggregation occurs.",
      "This calculation engine does not independently verify source documents, bank balances, revenue recognition or cost allocations."
    ]
  };
}
