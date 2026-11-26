# Batch 139 — payment webhook claim leases

Provider webhook delivery is at-least-once. A persisted event can be delivered concurrently, and a process can terminate after marking it as processing. Previously, duplicate deliveries in `received` or `processing` could continue through the settlement path.

## Change
- Adds `processing_started_at` and bounded `attempt_count` to the provider event ledger.
- Adds a SECURITY DEFINER RPC that locks the event row and atomically claims it.
- Active claims are held for five minutes by default; the RPC permits 30–900 seconds.
- Expired claims and previously failed events can be reclaimed.
- Processed, ignored and needs-review events are immutable duplicates.
- Event ID reuse with a different payload hash is rejected.
- Only service_role can execute the claim RPC.
- The application now claims before any provider settlement or subscription mutation.

## Recovery and limits
This serializes each event and recovers abandoned claims on redelivery. Provider retries remain the recovery trigger. A scheduled reconciliation process is still needed to find events that never get redelivered. This is not a substitute for a durable independent webhook worker.

## Validation
The CI workflow creates a disposable PostgreSQL 16 database, bootstraps only the required event-ledger shape, applies the additive migration, and exercises first claim, concurrent duplicate, expired lease reclaim, processed duplicate, and payload-hash conflict. It does not connect to Supabase, Neon, Render or production.

No staging or production migration is applied by this PR.
