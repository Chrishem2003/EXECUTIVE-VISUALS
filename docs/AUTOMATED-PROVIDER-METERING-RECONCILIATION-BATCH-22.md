# Batch 22 — Automated Provider Metering & Financial Reconciliation

## Delivered
- Provider-neutral usage normalization for OpenTelemetry GenAI semantic attributes and common provider usage payloads.
- Billable input/output token preference when a provider supplies both billable and raw token counts.
- RFC-4180-style invoice CSV parsing with quoted delimiters, escaped quotes, embedded newlines, bounded file size and line count, strict headers and integer minor-unit amounts.
- Admin-protected invoice import API accepting normalized line items or CSV text.
- Deterministic SHA-256 invoice fingerprints and idempotent import RPC.
- Exact-reference reconciliation between invoice lines and provider usage events, requiring provider, model, currency and amount agreement.
- Append-only reconciliation evidence; ambiguous, unmatched and variance cases remain visible instead of being silently force-matched.
- Daily provider/model cost-spike and failed-operation-cost anomaly analysis, unpriced usage surfacing and invoice exception reporting.
- Disposable PostgreSQL integration coverage for provider-reported usage, unknown-price handling, duplicate invoice imports, exact reconciliation and replay.
- Batch 21 financial intelligence period validation corrected to accept real ISO month dates.

## API routes
- POST /api/admin/finance/ai-usage
- POST /api/admin/finance/ai-invoices/import
- POST /api/admin/finance/ai-invoices/reconcile
- GET /api/admin/finance/ai-cost-anomalies
- GET /api/admin/finance/ai-cost-intelligence

All routes require a finance administrator role. Invoice imports are evidence capture, not provider credential-based invoice downloads. CSV content is processed in memory and is not persisted as a raw file. Only normalized line evidence and a one-way source fingerprint are stored.

## Accounting and matching rules
1. Provider usage cost and invoice line amount must agree exactly in currency and minor units before a match is recorded.
2. A match requires an exact provider invoice line reference, provider, model, currency and amount.
3. Multiple candidates are ambiguous; missing candidates are unmatched; amount disagreement is variance.
4. A usage event can be matched to at most one invoice line.
5. Reconciliation evidence is append-only. Repeated reconciliation returns the existing evidence.
6. Invoice header/line total differences remain explicit variance.
7. Catalog estimates are not promoted to invoice-confirmed costs.
8. Unknown pricing remains unpriced; anomaly reports surface it without inventing an amount.
9. Anomaly detection is advisory. It does not change customer bills, provider routing or model settings.

## Deliberate integration gates
This batch does not yet download invoices directly from provider accounts, enable provider-specific webhook credentials, instrument every existing generation/render adapter, allocate shared GPU/FFmpeg costs, deliver external alert notifications, or automatically route work to a different model. Those require provider-specific account access, exact adapter call sites, measured resource telemetry, approved thresholds and staged acceptance tests.

## Validation and safety
The billing quality workflow now applies Batch 22's migration after Batch 21, syntax-checks the new metering module, and runs the new tests plus PostgreSQL integration assertions. CI results must be inspected on the exact PR head before this work is considered validated. No production migration, merge, deployment, provider activation, live invoice fetch, or paid infrastructure change is performed by this batch.