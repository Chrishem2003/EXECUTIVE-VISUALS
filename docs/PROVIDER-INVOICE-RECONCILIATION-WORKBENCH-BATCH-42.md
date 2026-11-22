# Batch 42 — Provider invoice reconciliation workbench

**Status:** implementation branch; CI verification pending.  
**Scope:** connect existing provider invoice ingestion, exact usage reconciliation and immutable cost posting into the admin Financial Command Centre. This does not introduce a second invoice or billing ledger.

## Delivered

- Admin-only `GET /api/admin/finance/ai-invoices?limit=50` returns a bounded, newest-first import history with provider, invoice reference, currency, period, total, imported/matched line counts and reconciliation status.
- The invoice history endpoint rejects non-admin access and limits outside 1–100. It does not expose source document paths, credentials or customer payment information.
- The Financial Command Centre now includes a provider invoice CSV import form with explicit provider, invoice reference, currency, inclusive reporting dates and integer minor-unit total.
- CSV is sent to the existing `POST /api/admin/finance/ai-invoices/import` route, which validates rows, fingerprints the import and persists it through the existing `import_ai_provider_invoice` RPC.
- Imported invoice records are displayed with line-match counts and status.
- A finance administrator can explicitly trigger exact-reference reconciliation using the existing `reconcile_ai_provider_invoice` RPC.
- A separate “Post verified” action is rendered only when the imported record status is `matched`; the existing posting RPC remains authoritative and rejects unresolved or variant lines.
- The existing manual import-ID posting form is retained as an administrative fallback.

## Workflow

1. Export a provider invoice CSV with the required columns: `line_reference,model,operation,amount_minor,usage_period`. Optional columns: `usage_quantity,usage_unit,owner_id,project_id,job_id`.
2. Enter the invoice header and import the CSV.
3. Review the import in the invoice history table.
4. Run reconciliation. The existing server-side matcher uses exact provider line references and linked usage evidence; unmatched, ambiguous or variance lines remain exceptions.
5. Inspect the result and resolve source-data issues through the existing governed process.
6. Only a fully matched import can be posted to the immutable service-cost ledger.

## Safety

- Import, reconciliation and posting require a platform finance administrator.
- No fuzzy matching or automatic posting is introduced.
- No new invoice schema, parallel ledger, external storage or paid infrastructure is added.
- The UI never treats a daily aggregate as task-level settlement evidence.
- Posting remains an explicit action through the existing guarded RPC; the UI status is not an authorization boundary.
- No provider usage query, invoice upload, ledger posting, payment, production migration, merge or deployment was performed by this code change.

## Verification

Added API tests for admin-only invoice history, safe import summaries, bounded result limits and query ordering. Full repository quality checks and Financial Intelligence workflow must pass on the exact PR head before the batch can be considered verified.
