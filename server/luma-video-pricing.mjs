const SOURCE = "https://docs.agents.lumalabs.ai/guides/pricing/";
const USAGE_SOURCE = "https://docs.agents.lumalabs.ai/guides/usage/";
const DEFAULT_LIST_USD_PER_CREDIT = 0.003;
const fail = (message, code = "LUMA_PRICE_INVALID_INPUT") => Object.assign(new Error(message), { code });
const TABLES = Object.freeze({
  video: Object.freeze({
    sdr: Object.freeze({ "540p": Object.freeze({5:0.15,10:0.45}), "720p": Object.freeze({5:0.30,10:0.90}), "1080p": Object.freeze({5:1.20,10:3.60}) }),
    hdr: Object.freeze({ "720p": Object.freeze({5:0.60}), "1080p": Object.freeze({5:2.40}) }),
    hdrExr: Object.freeze({ "720p": Object.freeze({5:0.90}), "1080p": Object.freeze({5:3.60}) })
  }),
  video_edit: Object.freeze({
    sdr: Object.freeze({ "540p": Object.freeze({5:0.72,10:1.44}), "720p": Object.freeze({5:1.08,10:2.16}), "1080p": Object.freeze({5:2.16,10:4.32}) }),
    hdr: Object.freeze({ "540p": Object.freeze({5:1.44,10:2.88}), "720p": Object.freeze({5:2.16,10:4.32}), "1080p": Object.freeze({5:4.32,10:8.64}) }),
    hdrExr: Object.freeze({ "540p": Object.freeze({5:2.16,10:4.32}), "720p": Object.freeze({5:3.24,10:6.48}), "1080p": Object.freeze({5:6.48,10:12.96}) })
  }),
  video_extend: Object.freeze({ "540p":0.15, "720p":0.30, "1080p":1.20 }),
  video_reframe: Object.freeze({ "540p":0.06, "720p":0.12, "1080p":0.36 })
});

function validDate(value) {
  if (typeof value !== "string" || !/^20[0-9]{2}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}

/** Published Luma Agents Ray 3.2 price estimate; never invoice or settlement evidence. */
export function estimateLumaRay32Cost({ operation = "video", resolution, durationSeconds, hdr = false, exrExport = false, pricingDate } = {}) {
  if (!["video", "video_edit", "video_extend", "video_reframe"].includes(operation)) throw fail("Unsupported Ray 3.2 operation.");
  if (!["540p", "720p", "1080p"].includes(resolution)) throw fail("Resolution must be 540p, 720p or 1080p; the 360p draft tier is not enabled in the model capability contract.", "LUMA_PRICE_UNSUPPORTED_RESOLUTION");
  if (typeof hdr !== "boolean" || typeof exrExport !== "boolean") throw fail("hdr and exrExport must be booleans.");
  if (exrExport && !hdr) throw fail("EXR export requires HDR.", "LUMA_PRICE_UNSUPPORTED_OPTION");
  if (!validDate(pricingDate)) throw fail("pricingDate must be a valid explicit YYYY-MM-DD value.", "LUMA_PRICE_DATE_REQUIRED");
  let amount, billedDurationSeconds, formula;
  if (operation === "video_extend") {
    if (hdr || exrExport) throw fail("Video extend is standard-dynamic-range only.", "LUMA_PRICE_UNSUPPORTED_OPTION");
    if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 10)) throw fail("durationSeconds, when supplied for extend, must be between 0 and 10.");
    amount = TABLES.video_extend[resolution];
    billedDurationSeconds = 5;
    formula = "one fixed 5-second extend block";
  } else if (operation === "video_reframe") {
    if (hdr || exrExport) throw fail("Video reframe is standard-dynamic-range only.", "LUMA_PRICE_UNSUPPORTED_OPTION");
    if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300) throw fail("durationSeconds is required and must be greater than 0 and no greater than 300.");
    const rate = TABLES.video_reframe[resolution];
    amount = Number((durationSeconds * rate).toFixed(4));
    billedDurationSeconds = durationSeconds;
    formula = durationSeconds + "s × $" + rate.toFixed(2) + "/s";
  } else {
    if (![5,10].includes(durationSeconds)) throw fail("Video generation and editing duration must be 5 or 10 seconds.");
    if (operation === "video" && hdr && durationSeconds !== 5) throw fail("HDR video generation is available only for 5-second clips.", "LUMA_PRICE_UNSUPPORTED_OPTION");
    if (operation === "video" && hdr && !["720p","1080p"].includes(resolution)) throw fail("HDR video generation supports only 720p and 1080p.", "LUMA_PRICE_UNSUPPORTED_OPTION");
    const tier = exrExport ? "hdrExr" : hdr ? "hdr" : "sdr";
    const amountForResolution = TABLES[operation][tier][resolution];
    amount = amountForResolution?.[durationSeconds];
    if (amount === undefined) throw fail("The selected HDR/EXR operation, resolution and duration combination is not priced.", "LUMA_PRICE_UNSUPPORTED_OPTION");
    billedDurationSeconds = durationSeconds;
    formula = operation + " " + tier + " " + resolution + " " + durationSeconds + "s fixed published rate";
  }
  const credits = Math.round(amount / DEFAULT_LIST_USD_PER_CREDIT);
  const listRateAmount = Number((credits * DEFAULT_LIST_USD_PER_CREDIT).toFixed(6));
  return Object.freeze({
    provider: "luma", model: "ray-3.2", operation, resolution,
    billedDurationSeconds, credits, currency: "USD", amount: listRateAmount,
    basis: "default_list_rate_usd_per_credit",
    creditToUsdRate: DEFAULT_LIST_USD_PER_CREDIT,
    monetaryEstimateScope: "default_list_rate_only_account_plan_or_contract_rate_may_differ",
    pricingSource: SOURCE, usageSource: USAGE_SOURCE, pricingDate,
    pricingStatus: "subject_to_change_before_general_availability",
    pricingFormula: formula + "; " + credits + " credits × $" + DEFAULT_LIST_USD_PER_CREDIT.toFixed(3) + "/credit",
    billable: false, settlementEligible: false
  });
}
