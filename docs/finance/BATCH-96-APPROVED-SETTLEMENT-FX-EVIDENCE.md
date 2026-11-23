# Batch 96 — Approved settlement FX evidence

**Status:** implemented on a draft branch; exact-head CI pending.
**Base:** Batch 95 / PR #832 (`feat/credit-pack-overage-profitability-batch-95-2026-11-23`).

## Why this batch exists

Batch 95 correctly blocked UGX credit-pack contribution when provider invoice costs were measured in USD. Batch 96 adds an audited evidence path for converting those costs only when an actual processor settlement or bank statement supports the conversion.

## Accounting distinction

- The Uganda Revenue Authority exchange-rate report publishes an Income Tax USD/UGX rate of 4,216.9 for 23 November 2026. This is a tax/reporting reference and is **not** treated as a processor or bank settlement rate.
- Bank of Uganda publishes opening reference rates; these are also reference rates, not proof of the exchange actually applied to a specific settlement.
- Flutterwave's public Uganda pricing page currently lists 3% for local wallets/mobile money and 4.8% for local cards; it says fees exclude VAT and other applicable taxes. Its VAT guidance lists Uganda at 15% on transaction fees. These published rates are planning assumptions only; actual transaction fees and VAT must be reconciled against processor statements and the merchant tax invoice.
- Pesapal's Uganda FAQ says transaction fees are available on its pricing page and the merchant dashboard, so the actual signed merchant schedule and statements remain the source of truth.

Sources checked 23 November 2026:
- URA exchange-rate report: https://ura.go.ug/en/exchange-rates/
- Bank of Uganda official account / rate announcements: https://x.com/BOU_Official
- Flutterwave Uganda pricing: https://flutterwave.com/ug/pricing/
- Flutterwave VAT explanation: https://flutterwave-website-v3-pilot.f4b-flutterwave.com/us/support/pricing/value-added-tax-vat-for-flutterwave-merchants
- Pesapal Uganda business FAQ: https://www.pesapal.com/ug/business/faqs

## Implemented

- Append-only FX evidence table with source/target currencies, fixed 1e8 rate precision, effective date, source type, purpose, evidence reference/hash, recorder and idempotency key.
- Separate append-only decision table for approvals, rejections and revocations.
- Maker-checker rule: the evidence recorder cannot approve/reject/revoke their own evidence.
- Finance-admin API to record evidence, list evidence and submit decisions.
- Read-only current-decision view used by the credit-pack profitability calculation.
- Exact-month selection and conservative ceiling conversion to the target currency's minor unit.
- UGX credit-pack profitability now uses FX only when evidence is approved, same-month, USD→UGX, purpose `settlement_cost`, and source is a processor settlement or bank statement.
- Official-reference and tax-reference rates are explicitly rejected for settlement-cost conversion.
- Financial Command Centre shows FX evidence type/date and blocked reason.

## Safety

- No public FX rate is fetched and silently applied to historical costs.
- No database changes are applied to a live environment by this PR; migration is staging-first and review-required.
- FX evidence is not auto-approved. A different finance administrator must make the decision.
- No payment, credit grant, product activation, subscription entitlement, price, checkout or wallet/ledger behavior changes.
- No production deploy, merge or paid infrastructure.

## Verification

- `npm run verify:approved-fx-evidence`
- `npm run verify:credit-pack-overage-economics`
- Existing Financial Intelligence, Billing self-service, Neon PostgreSQL integration and Quality Checks on the exact PR head.

## Remaining commercial controls

- Reconcile Flutterwave/Pesapal transaction fee rates by payment method and actual settlement currency.
- Capture VAT on gateway fees from the provider's tax invoice/statement; do not assume the statutory customer VAT rate is the gateway-fee VAT treatment without evidence.
- Include refunds, chargebacks, failed/retried jobs, storage, egress, render compute, delivery, support and acquisition before calling contribution margin net profit.
- Keep all $9 / $29 / $79 / $199 plan prices and credit allowances as draft hypotheses until measured cost and payment settlement evidence is complete.