# Batch 58 — Exact-hash subscription allowance dual-approval policy

**Status:** implementation and automated tests added; CI and review pending.  
**Scope:** add a deterministic approval packet and separation-of-duties evaluator to the existing invoice-backed subscription allowance simulator.

## What changed

- Every simulated plan with a positive allowance and verified invoice-backed cost evidence now receives an approval packet.
- The packet binds the exact plan code, proposed plan version, currency, monthly price, included credits, measured provider cost per platform credit, evidence period/source/method/sample size and all financial assumptions.
- A SHA-256 proposal hash identifies that exact combination. Changing any bound input creates a different hash and requires fresh approvals.
- Two distinct, server-loaded approvals are required:
  - Finance: `billing_admin`.
  - Product: `platform_admin`.
- A rejection blocks the proposal. A single person cannot satisfy both stages. Wrong-role records and approvals for another hash do not count.
- The evaluator returns `eligibleToPublish` only after both exact-hash approvals; it never publishes a plan or grants credits.

## Important release boundary

This batch is an approval-policy foundation, not the durable approval workflow or publication endpoint. Approval records must be loaded from a trusted server-side store; browser-submitted approval rows and role claims are not trusted. The next integration step is to persist proposal packets and approval decisions in a restricted, append-only database workflow, add audit-chain events, and revalidate the live plan version and proposal hash inside the same transaction that performs any future publication.

Even a fully approved packet returns `publishable: false`. A separate audited publication command is mandatory. No public catalogue, subscription entitlement, customer wallet, credit balance, payment, or production setting is changed by this batch.

## Verification

- Unit coverage includes minimum sample size, verified evidence status, two-stage approvals, role separation, rejection, same-person rejection, stale hashes, and plan/cost/allowance invalidation.
- Financial-intelligence CI now syntax-checks the module and runs the new tests.
- No provider API calls, migrations, production writes, merge, or deployment are included.
