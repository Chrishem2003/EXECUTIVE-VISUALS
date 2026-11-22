# Subscription entitlement and catalogue contract

This branch adds a fail-closed subscription policy and a read-only plan-catalogue normalizer. Both consume trusted server/database records; neither accepts plan, price, credit or entitlement claims from browser input.

## Entitlement policy

- Requires an active subscription, valid plan code/version, a verifiable future billing-period end and a bounded immutable entitlement snapshot.
- Preserves access through the paid period when cancellation is scheduled at period end; access ends when the period expires.
- Evaluates boolean capabilities, provider/model allowlists, numeric entitlements and usage limits.
- Rejects missing entitlements, malformed snapshots and prototype-path traversal.
- Exposes stable assertion helpers for server-side authorization.

## Catalogue behavior

- Publishes only active, public plans within optional effective-from/effective-until windows.
- Requires versioned plan identity and bounded immutable entitlement JSON.
- Validates Paddle price identifiers and USD/EUR/GBP mapping; validates Pesapal UGX mapping without a provider price ID.
- Exposes checkout provider options only where an active provider-price mapping exists.
- Never publishes an included-credit allowance unless the trusted plan record carries an explicit `credit_allowance_published=true` flag and a positive configured allowance.
- This catalogue is read-only. Checkout still uses the existing provider billing reservation RPC and remains gated by sandbox readiness.

## Credit and margin policy

- Keep provider cost forecast, budget reservation, realized provider cost, customer credit reservation, settled credits and refunds distinct.
- Reuse the existing workload economics rate-card engine and margin policy; do not add a second pricing formula.
- Do not configure plan credit quantities until model/resolution/audio mixes, retakes, billable failures, FX, payment fees, storage, egress and rendering are costed.
- The suggested $9/$29/$79/$199 amounts remain experiments. Provider price rows remain operator-controlled and are not seeded by this change.

## Remaining integration work

1. The authenticated `/api/billing/plans` endpoint now loads plan rows and active Paddle/Pesapal price mappings through the server database client, validates them with the catalogue policy and returns a versioned customer DTO. The existing billing workspace already consumes this endpoint; its legacy plan fields are preserved.
2. The same opt-in gate now protects both sides of the cloud video pipeline. The authenticated dispatch checks `features.videoGeneration` before registering/enqueuing a new approval; the dedicated provider-aware worker rechecks the trusted subscription immediately before its durable provider-submission transition. Temporary subscription lookup failures defer the job, while missing access or ambiguous subscriptions are quarantined without a provider call. `CLOUD_VIDEO_SUBSCRIPTION_ENTITLEMENTS_REQUIRED=true` must be set on both the API service and the dedicated video-worker service; the worker refuses the flag unless `CLOUD_VIDEO_WORKER_ENABLED=true`. It defaults to false and must remain off until active plan snapshots are populated and staging-verified. Quote creation and monthly credit grant integration remain separate next steps.
3. Add verified-renewal idempotent credit grants, lifecycle semantics and agency shared pools.
4. Add margin-floor scenarios using the existing dated provider rate cards and measured usage telemetry.
5. Complete isolated Paddle/Pesapal sandbox and Neon/PostgreSQL acceptance before enabling checkout or paid generation.

No migrations, credentials, live checkout, production configuration or deployments are changed by this slice. The cloud video subscription gate is opt-in and remains disabled by default; it is not a production activation. The customer catalogue, dispatch gate, and final worker submission gate are covered by automated tests. The UI can display the validated catalogue, but checkout remains separately gated and still reserves its price through the existing database RPC.
