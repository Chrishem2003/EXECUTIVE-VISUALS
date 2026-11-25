# Batch 119 — Job-level storage and egress cost evidence

## Scope
Adds a pure, read-only evidence adapter for measured storage and egress resource events. It reuses the existing `ai_resource_usage_events` and `ai_resource_rate_cards` concepts and the existing versioned resource-rate contract; it does not add a table, migration, RPC, ledger, or billing path.

## Evidence rules
- Exact persisted job UUID attribution.
- Only `storage_gb_day` and `egress_gb` are categorized in this batch.
- Accepts machine-measured event provenance (`worker_instrumentation` or `cloud_provider_meter`) only.
- Requires exactly one rate card matching provider, resource type, unit, currency and effective date.
- Requires a positive rate and evidence reference. Cost is rounded up to the next minor unit to avoid understating measured variable cost.
- Duplicate IDs, unsupported provenance, missing/stale/ambiguous rates and mixed currencies remain exceptions.
- No FX, monthly allocation, estimates, credit settlement, ledger writes or dispatch unlock.

## Important boundary
This adapter produces historical actuals only. It deliberately does not emit Batch 117 preflight evidence and cannot be passed off as a future per-shot forecast. The current worker instrumentation may not yet produce storage/egress events; in that case the result remains missing rather than reporting zero.

## Verification
Run:
```sh
node --test server/tests/job-resource-cost-evidence.test.mjs
```
