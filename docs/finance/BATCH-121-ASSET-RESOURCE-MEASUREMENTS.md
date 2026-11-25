# Batch 121 — Private asset resource measurement primitives

## Scope
Adds pure, tested measurement builders for exact private-asset storage-retention intervals and completed HTTP egress. Both use the existing resource contract: `storage_gb_day` / `gb_day` and `egress_gb` / `gb`.

## Accounting rules
- Decimal GB (1,000,000,000 bytes) is explicit and consistent with the resource-unit contract.
- Storage is measured as asset bytes × elapsed UTC seconds / 86,400,000,000,000 byte-seconds per GB-day.
- Egress is measured from actual completed response bytes, not a requested content length or a signed-URL issuance.
- Asset and owner UUID attribution is mandatory; project attribution is validated when present.
- Reversed/zero storage intervals, invalid sizes, impossible transfer sizes and unstable transfer IDs are rejected.
- Each interval/transfer receives a stable measurement identity so the caller can safely retry the same immutable event.
- The helper returns the owner/project/asset attribution separately from the measurement payload; callers must not invent a generation job ID.

## Integration boundary
This batch adds measurement primitives and regression tests only. It does not yet schedule durable storage-retention checkpoints or wire upload/download/delete handlers to the financial event writer. Therefore it does not claim that production asset costs are currently being captured. The next integration step must record events idempotently before advancing a persisted per-asset checkpoint, and must verify local, cloud and multipart asset paths independently.

No schema migration, ledger write, rate-card mutation, provider execution, production deployment or paid infrastructure change.
