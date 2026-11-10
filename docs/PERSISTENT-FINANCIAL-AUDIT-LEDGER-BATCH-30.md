# Batch 30 — Persistent Financial Close & Tamper-Evident Audit Ledger

## Scope

Batch 30 adds a persistent financial audit event ledger for financial close and evidence lifecycle events. The ledger is separate from source accounting records: it records attributable control events and never changes invoices, payments, reconciliations, customer balances or journals.

## Event contract

Supported event types:

- \`close_period.created\`
- \`close_task.assigned\`
- \`close_task.completed\`
- \`close_task.waived\`
- \`reconciliation.reviewed\`
- \`close_approval.recorded\`
- \`close_period.reopened\`
- \`evidence.attached\`
- \`evidence.retention_changed\`

Each event includes a UUID, owner and actor IDs, contiguous sequence, UTC timestamp, idempotency key, JSON-safe payload, canonicalization version, SHA-256 algorithm marker, previous hash and event hash. Payloads are bounded to 16 KiB and reject non-integer numeric values; decimal money values must be represented as integer minor units or canonical decimal strings.

## API

- \`POST /api/admin/finance/audit/events\`: append one event. Requires a finance administrator and an idempotency key.
- \`GET /api/admin/finance/audit/events\`: retrieve a bounded page of ordered events and the current chain head.
- \`GET /api/admin/finance/audit/verify\`: verify the chain from genesis through the stored head, with a 5,000-event verification cap.

All routes require the existing authenticated owner identity and administrator authorization. The API uses the existing server-side Supabase service-role client. No service-role credentials are exposed to the browser.

## Persistence and integrity

Migration: \`supabase/migrations/20261112090000_persistent_financial_audit_ledger_batch_30.sql\`

- \`financial_audit_events\` stores event envelopes and canonical bytes with unique owner/sequence, event UUID and owner/idempotency constraints.
- \`financial_audit_heads\` stores the last committed sequence and hash for each owner.
- The append RPC serializes writes per owner using a transaction-scoped advisory lock, checks the expected head, verifies canonical JSON and recomputes the SHA-256 digest inside PostgreSQL before insert.
- Event rows have a database trigger rejecting UPDATE and DELETE. Application roles receive SELECT only; event insertion is available through the controlled security-definer append RPC.
- Repeated idempotency keys with the same actor, event type and payload return the original event. Reuse with a different payload is rejected.
- Corrections must be new compensating events; historical entries are not edited.

## Verification and limitations

The verifier checks contiguous sequence, owner scope, previous-hash linkage, event hash, duplicate idempotency keys and an optional trusted head. It localizes the first detected break.

A hash chain alone cannot prove that an operator with full database control did not replace the entire chain and recompute it. This batch does not yet publish checkpoints to independent WORM storage, a timestamp authority or a separately controlled witness. External checkpoint anchoring, key custody, retention automation and offline audit bundle signing remain future work.

The ledger records event payload metadata only. It does not upload or persist evidence files, validate their source bytes, authenticate external provider records, sign a financial close, lock periods or post journals. Actor identity is taken from the authenticated administrator session; the database stores the actor reference but does not independently attest to the identity provider.

## Safety

- No production database migration or deployment is performed by this pull request.
- CI applies the migration only to a disposable PostgreSQL database.
- No bank, payment-provider, object-storage or external anchoring connector is activated.
- No accounting or payment record is mutated.

## Validation

Unit tests cover canonical serialization, valid chains, payload tampering, sequence gaps, owner mismatches, forked links, trusted-head mismatch, duplicate idempotency and invalid payloads. API tests cover administrator access, append contract, read-only retrieval and verification. PostgreSQL integration tests cover append, idempotent replay, contiguous head updates and database-enforced update/delete rejection.
