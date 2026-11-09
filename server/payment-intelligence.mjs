import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CURRENCY_DECIMALS = Object.freeze({
  UGX: 0, KES: 2, NGN: 2, GHS: 2, ZAR: 2, USD: 2, EUR: 2, GBP: 2
});

const REFUND_STATUS = Object.freeze({
  new: "processing",
  pending: "processing",
  processing: "processing",
  succeeded: "succeeded",
  failed: "failed",
  completed: "processing",
  "pending-momo": "processing",
  "pending-bank-transfer": "processing",
  "pending-mpgs": "processing",
  "completed-bank-transfer": "succeeded",
  "completed-momo": "succeeded",
  "completed-mpgs": "succeeded",
  "completed-offline": "succeeded",
  "completed-preauth": "succeeded"
});

const TRANSIENT_FAILURES = new Set([
  "timeout", "network_error", "processor_unavailable", "temporary_error",
  "rate_limited", "gateway_error", "service_unavailable"
]);

function safeEqualText(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Flutterwave v4 signs the exact raw request body with HMAC-SHA256/base64. */
export function verifyFlutterwaveWebhook(rawBody, signature, secretHash) {
  if (!Buffer.isBuffer(rawBody) || !rawBody.length || typeof secretHash !== "string" || !secretHash) return false;
  const expected = createHmac("sha256", secretHash).update(rawBody).digest("base64");
  return safeEqualText(expected, signature);
}

/** Legacy v3 webhook verification uses the configured verif-hash header. */
export function verifyFlutterwaveV3Webhook(verifHash, secretHash) {
  return safeEqualText(verifHash, secretHash);
}

export function hashWebhookPayload(rawBody) {
  if (!Buffer.isBuffer(rawBody)) throw new TypeError("Webhook payload must be the original raw request body.");
  return createHash("sha256").update(rawBody).digest("hex");
}

export function parseRefundStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return REFUND_STATUS[normalized] ?? "processing";
}

export function getCurrencyDecimals(currency) {
  const code = String(currency ?? "").toUpperCase();
  if (!Object.hasOwn(CURRENCY_DECIMALS, code)) {
    throw Object.assign(new Error(`Unsupported currency precision: ${code || "missing"}.`), { code: "UNSUPPORTED_CURRENCY" });
  }
  return CURRENCY_DECIMALS[code];
}

export function minorToMajor(amountMinor, currency) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw Object.assign(new Error("Amount must be a positive safe integer in minor units."), { code: "INVALID_AMOUNT" });
  }
  const decimals = getCurrencyDecimals(currency);
  return Number((amountMinor / (10 ** decimals)).toFixed(decimals));
}

export function validateRefundRequest({
  paymentStatus, paymentAmountMinor, alreadyRefundedMinor = 0,
  requestedAmountMinor, paymentCurrency, requestedCurrency = paymentCurrency
}) {
  if (paymentStatus !== "successful") {
    throw Object.assign(new Error("Only a verified successful payment can be refunded."), { code: "PAYMENT_NOT_REFUNDABLE" });
  }
  if (!Number.isSafeInteger(paymentAmountMinor) || paymentAmountMinor <= 0 ||
      !Number.isSafeInteger(alreadyRefundedMinor) || alreadyRefundedMinor < 0 ||
      !Number.isSafeInteger(requestedAmountMinor) || requestedAmountMinor <= 0) {
    throw Object.assign(new Error("Refund amounts must be positive safe integers in minor units."), { code: "INVALID_REFUND_AMOUNT" });
  }
  if (String(paymentCurrency).toUpperCase() !== String(requestedCurrency).toUpperCase()) {
    throw Object.assign(new Error("Refund currency must match the original payment currency."), { code: "REFUND_CURRENCY_MISMATCH" });
  }
  if (alreadyRefundedMinor + requestedAmountMinor > paymentAmountMinor) {
    throw Object.assign(new Error("Refund exceeds the remaining refundable amount."), {
      code: "REFUND_EXCEEDS_REMAINING",
      remainingMinor: Math.max(0, paymentAmountMinor - alreadyRefundedMinor)
    });
  }
  return {
    amountMinor: requestedAmountMinor,
    remainingAfterMinor: paymentAmountMinor - alreadyRefundedMinor - requestedAmountMinor,
    isPartial: alreadyRefundedMinor + requestedAmountMinor < paymentAmountMinor
  };
}

/**
 * Calculate a cumulative proportional credit reversal using integer arithmetic.
 * Include pending/in-flight refunds in cumulativeRefundedMinor before accepting
 * another refund, but call this only after the provider confirms success.
 */
export function calculateCreditReversal({
  originalCreditUnits, originalPaymentAmountMinor,
  cumulativeConfirmedRefundedMinor, alreadyReversedCreditUnits = 0
}) {
  for (const [name, value] of Object.entries({
    originalCreditUnits, originalPaymentAmountMinor,
    cumulativeConfirmedRefundedMinor, alreadyReversedCreditUnits
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw Object.assign(new Error(`${name} must be a non-negative safe integer.`), { code: "INVALID_CREDIT_REVERSAL_INPUT" });
    }
  }
  if (originalPaymentAmountMinor === 0 || originalCreditUnits === 0) {
    return { targetReversedCreditUnits: 0, reversalDelta: 0 };
  }
  if (cumulativeConfirmedRefundedMinor > originalPaymentAmountMinor) {
    throw Object.assign(new Error("Confirmed refunds exceed the original payment."), { code: "REFUND_TOTAL_EXCEEDED" });
  }
  const target = Number(
    (BigInt(originalCreditUnits) * BigInt(cumulativeConfirmedRefundedMinor)) /
    BigInt(originalPaymentAmountMinor)
  );
  if (alreadyReversedCreditUnits > target || alreadyReversedCreditUnits > originalCreditUnits) {
    throw Object.assign(new Error("Existing credit reversal exceeds the calculated cumulative reversal."), { code: "CREDIT_REVERSAL_INCONSISTENT" });
  }
  return { targetReversedCreditUnits: target, reversalDelta: target - alreadyReversedCreditUnits };
}

export function shouldRetryPaymentFailure(failureCode) {
  return TRANSIENT_FAILURES.has(String(failureCode ?? "").trim().toLowerCase());
}

export function calculatePaymentRetryAt({
  attemptNumber, now = new Date(), baseDelayMs = 5 * 60_000,
  maxDelayMs = 24 * 60 * 60_000
}) {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 10) {
    throw Object.assign(new Error("Payment retry attempt must be between 1 and 10."), { code: "INVALID_RETRY_ATTEMPT" });
  }
  const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attemptNumber - 1)));
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("Retry base time must be a valid date.");
  return new Date(date.getTime() + delay).toISOString();
}

/** Server-side Flutterwave v4 refund request. Never expose the secret key to clients. */
export async function initiateFlutterwaveRefund({
  chargeId, amountMinor, currency, reason, idempotencyKey, traceId,
  secretKey = process.env.FLW_SECRET_KEY,
  baseUrl = process.env.FLW_API_BASE_URL || "https://developersandbox-api.flutterwave.com",
  fetchImpl = fetch
}) {
  if (!secretKey) throw Object.assign(new Error("Flutterwave secret key is not configured."), { code: "PAYMENT_PROVIDER_NOT_CONFIGURED" });
  if (!chargeId || !idempotencyKey || !traceId || !reason) {
    throw Object.assign(new Error("Charge, reason, idempotency key and trace ID are required."), { code: "INVALID_REFUND_REQUEST" });
  }
  const amount = minorToMajor(amountMinor, currency);
  const response = await fetchImpl(new URL("/refunds", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
      "x-trace-id": traceId
    },
    body: JSON.stringify({ amount, reason, charge_id: chargeId })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || `Flutterwave refund request failed with HTTP ${response.status}.`);
    error.code = "FLUTTERWAVE_REFUND_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  if (!payload?.data?.id) {
    throw Object.assign(new Error("Flutterwave returned an invalid refund response."), { code: "INVALID_PROVIDER_RESPONSE" });
  }
  return {
    providerRefundId: String(payload.data.id),
    status: parseRefundStatus(payload.data.status),
    amountRefunded: payload.data.amount_refunded ?? amount,
    chargeId: payload.data.charge_id ?? chargeId,
    providerPayload: payload
  };
}
