# Batch 28 — Automated Financial Reconciliation & Revenue Assurance

## Scope

Batch 28 adds a deterministic, administrator-only reconciliation workbench. It is a read-only preview layer over source records exported from approved provider statements and internal finance records.

## Capabilities

- Provider invoice duplicate scan using normalized provider + invoice reference + currency.
- Invoice header totals reconciled against the sum of supplied invoice lines.
- Exact one-to-one invoice-line-to-metered-usage matching.
- Exact payment settlement-to-internal-payment matching.
- Detection of unmatched, duplicate, ambiguous, invalid and amount/model/operation/period variance cases.
- Currency-separated source and matched totals.
- A Financial Command Centre workbench accepting structured JSON and rendering the full preview.
- Bounded input populations (maximum 5,000 records per collection).

## API

`POST /api/admin/finance/reconciliation-preview`

Supported payload collections:

- `invoiceHeaders`: provider, invoiceReference, currency, totalMinor, optional sourceId.
- `invoiceLines` can be supplied with `invoiceHeaders` to reconcile header totals against line totals.
- `invoiceLines` and `usageEvents`: exact provider line reference, currency, model, operation, usage period and provider-reported cost.
- `statementRows` and `payments`: provider transaction reference, currency, exact minor-unit amount and internal payment settlement status.

At least one complete collection pair is required. The route requires owner, platform_admin or billing_admin.

## Matching controls

- Provider references are normalized for case, spaces and hyphens only.
- Currency must match exactly; no FX conversion or cross-currency netting is performed.
- Amounts are integer minor units and must match exactly.
- Invoice usage matching also requires provider, invoice line reference, model, operation and usage period.
- Payment matching requires provider, transaction reference, currency, exact amount and a settled/successful internal status.
- Duplicate references, ambiguous candidates and unmatched source records remain exceptions.
- No fuzzy match is auto-cleared.

## Safety and limitations

- The preview does not write database records, post invoices, change ledgers, initiate payments, issue refunds or modify subscriptions.
- Existing verified invoice reconciliation and explicit ledger-posting RPCs remain the authoritative posting controls.
- Input records are supplied by an authorized finance administrator; this batch does not yet ingest bank statements or provider settlement APIs automatically.
- The duplicate scan is a review signal, not proof of fraud.
- A balanced preview is not an audited close or statutory financial statement; human approval and source-document verification remain mandatory.
- No database migration, production deployment, external provider connection, payment action or production configuration change is included.

## Validation

- Unit tests cover normalized duplicate invoices, exact invoice-to-usage matching, ambiguous matches, currency separation, settlement amount/status checks, malformed amounts and input bounds.
- API tests cover admin authorization, incomplete input, read-only behavior and malformed data rejection.
- The Financial Command Centre includes the reconciliation workbench.
