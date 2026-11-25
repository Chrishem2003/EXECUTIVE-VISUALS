# Batch 118 — Server-side job cost evidence reconciliation

**Status:** read-only source-chain adapter and finance-admin API implemented.  
**Base:** Batch 117 / PR #872.

## Delivered

- Adds `server/job-cost-source-evidence-readiness.mjs`, which reconciles one persisted job against the existing immutable financial source chain:
  1. provider usage event,
  2. exact invoice-line reconciliation event,
  3. provider invoice import and complete invoice line set,
  4. immutable financial service-cost event,
  5. immutable financial cost-attribution link.
- Requires exact job, provider, model, operation, amount, currency, owner, project and period consistency.
- Verifies the full imported invoice header total against all imported lines and requires a one-to-one matched reconciliation event for every line.
- Uses the reconciliation event as the authoritative invoice-line-to-usage relationship. The original invoice import and line rows are append-only and intentionally retain their initial pending/unmatched fields; the adapter does not mistake those immutable initial fields for final reconciliation state.
- Requires a provider-reported usage cost and a posted provider-invoice service-cost event. Catalog estimates and unposted usage estimates do not qualify.
- Converts the verified invoice amount from ISO currency minor units to six-decimal evidence units without FX conversion; unsupported precision fails closed.
- Adds `GET /api/admin/finance/job-cost-evidence-readiness?jobId=<uuid>`, protected by the existing finance-admin role check and private service-role database client.
- Adds regression tests for access control, source-chain integrity, duplicate attribution, invoice completeness, amount/owner/category mismatches, failed-but-billable provider jobs, mixed currencies and missing job-level categories.

## Accounting boundaries

The endpoint reports **historical actuals**, not a future generation quote. A failed generation can still have a real provider charge; a terminal failed status is not treated as zero cost.

Only provider compute with an exact, fully reconciled invoice chain is currently reportable at job level. The existing schema's shared/monthly cost records do not carry exact job IDs for storage, egress, payment processing, moderation, retries, tax, refund reserve or support. These categories are explicitly returned as `missing_job_level_evidence`; they are not arbitrarily allocated to a job.

The endpoint deliberately returns:
- `fullyLoadedReady: false`
- `dispatchEvidenceEligible: false`

It does not return the Batch 117 preflight evidence object and cannot unlock generation. Historical provider invoice actuals are not re-labelled as future per-shot cost forecasts.

## Safety

- Read-only REST queries only; no SQL/RPC writes or schema migration.
- No ledger posting, credit settlement/release, subscription/payment action, provider call, generation dispatch, deployment or merge.
- No FX conversion, fuzzy matching, synthetic shared-cost allocation or inferred zero-cost categories.
