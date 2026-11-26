# Batch 128 — Durable private egress attempt journal

## What changed
- Adds an immutable-identity, append-once transfer intent row before the private object stream begins.
- Records terminal outcome, actual response-stream bytes, upstream status, measurement identity and sanitized error code.
- An abandoned `started` row is an unknown/interrupted transfer and is never treated as billable usage.
- Database functions are service-role-only, verify a financial administrator and validate asset ownership/project attribution.
- Journal writes are idempotent and conflicting reuse of a transfer ID is rejected.

## Operational boundary
This closes the previous gap where a completed response could be delivered before the accounting RPC had any durable record of the transfer attempt. It does not prove bytes reached the user's disk, and an abrupt process death can leave a `started` row. A future reconciliation worker must inspect those rows without inventing chargeable bytes. The existing byte measurement remains the only billable evidence.

## Rollout
The migration is additive and intended for an isolated staging database first. No production migration, feature-flag activation, provider activation or deployment is performed by this PR.
