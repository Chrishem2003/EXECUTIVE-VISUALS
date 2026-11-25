# Batch 117 — Fully-loaded variable-cost evidence contract

**Status:** implemented as a read-only validation contract; database adapter and dispatch wiring remain separate follow-up work.  
**Base:** Batch 116 / PR #871 after rebasing onto the corrected Batch 115 head.

## Delivered

- Adds `server/fully-loaded-cost-evidence.mjs`, a pure server-side contract for the nine cost categories already required by the platform margin evaluator:
  - compute
  - storage
  - egress
  - payment processing
  - moderation
  - retry allowance
  - tax
  - refund reserve
  - support
- Requires exactly one source record per category and exact shot/currency identity.
- Restricts source classes by category (for example, payment settlement fee evidence for payment processing and approved reserve policy evidence for refund reserve).
- Requires immutable/verified source flags, a SHA-256 source digest, a stable source-record reference, observation time and expiry.
- Rejects stale, future-dated, expired, duplicate, cross-shot, cross-currency and unsupported evidence.
- Allows a zero amount only when the source explicitly attests zero-cost evidence.
- Rejects counting one source record more than once across categories.
- Produces deterministic canonical SHA-256 evidence references and a category-by-category breakdown.
- Adds a production-level wrapper that validates every shot independently and blocks the entire production if one shot is incomplete.
- Adds a dedicated `npm run verify:fully-loaded-cost-evidence` command and adversarial regression tests.

## Important trust boundary

This module validates a contract; it does **not** independently authenticate a database row or provider invoice. The booleans `immutable` and `verified` are meaningful only when set by a server-side adapter that has independently read and validated the referenced immutable source records. Browser-supplied evidence must never be accepted.

The next integration batch must load the exact evidence from the existing financial ledgers, invoice attribution, settlement fee, resource metering and approved policy records. It must not accept client-provided cost amounts or source digests. Until that adapter is verified and connected to generation preflight, the existing margin evaluator continues to block generation because the fully-loaded variable-cost model is unavailable.

## Safety

- No schema migration or database write.
- No invoice posting, customer wallet/credit mutation, subscription changes, payment calls, provider generation, refunds or dispatch.
- No invented cost values, inferred zero-cost categories, FX conversions or fuzzy source matching.
- No production deployment, merge or paid infrastructure changes.
