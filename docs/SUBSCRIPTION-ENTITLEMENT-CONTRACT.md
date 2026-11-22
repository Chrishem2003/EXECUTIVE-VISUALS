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
- The Neon staging quote/settlement conversion now reuses the existing `ai-workload-economics` pricing engine through `priceWorkloadCostUnits`; it does not add a second margin formula. `NEON_CUSTOMER_CREDITS_PER_USD` converts the engine's minimum USD-micro sale price into customer credits, while `NEON_CUSTOMER_TARGET_MARGIN_BPS` is required and payment-fee/support-reserve assumptions use the same shared engine defaults or explicit overrides. Credits are rounded upward. This remains a staging policy guard, not a substitute for measured provider/model mixes, storage, egress, rendering, taxes or FX.

## Remaining integration work

1. The authenticated `/api/billing/plans` endpoint now loads plan rows and active Paddle/Pesapal price mappings through the server database client, validates them with the catalogue policy and returns a versioned customer DTO. The existing billing workspace already consumes this endpoint; its legacy plan fields are preserved.
2. The same opt-in gate now protects both sides of the cloud video pipeline. The authenticated dispatch checks `features.videoGeneration` before registering/enqueuing a new approval; the dedicated provider-aware worker rechecks the trusted subscription immediately before its durable provider-submission transition. Temporary subscription lookup failures defer the job, while missing access or ambiguous subscriptions are quarantined without a provider call. `CLOUD_VIDEO_SUBSCRIPTION_ENTITLEMENTS_REQUIRED=true` must be set on both the API service and the dedicated video-worker service; the worker refuses the flag unless `CLOUD_VIDEO_WORKER_ENABLED=true`. It defaults to false and must remain off until active plan snapshots are populated and staging-verified. Quote creation and monthly credit grant integration remain separate next steps.
3. Initial purchase and verified renewal credit grants already exist in the Paddle/Pesapal SQL finalizers, using payment-scoped idempotency keys and the existing append-only credit ledger. The disposable PostgreSQL billing integration now asserts grant amount, single-entry behavior and replay safety for Paddle and Pesapal initial purchases and renewals. Remaining lifecycle work is explicit upgrade/downgrade proration, credit expiry/rollover and agency shared pools.
4. The Neon quote/settlement policy now calls the shared workload-economics pricing engine for verified USD provider cost and converts its minimum price into credits. Remaining profitability acceptance must add representative model/resolution/duration mixes, billable retry and cancellation outcomes, measured storage/egress/render costs, payment fees and verified FX before publishing credit allowances or prices.
5. Complete isolated Paddle/Pesapal sandbox and Neon/PostgreSQL acceptance before enabling checkout or paid generation.

No migrations, credentials, live checkout, production configuration or deployments are changed by this slice. The cloud video subscription gate is opt-in and remains disabled by default; it is not a production activation. The customer catalogue, dispatch gate, final worker submission gate, shared-engine customer-credit pricing and subscription-grant PostgreSQL replay assertions are covered by automated tests. The UI can display the validated catalogue, but checkout remains separately gated and still reserves its price through the existing database RPC.


## Project shared credit pools

Projects may opt into a project-scoped shared generation-credit pool. The project owner configures the pool and transfers credits from their personal generation-credit balance; funding writes a personal-wallet debit and project-wallet credit in one database transaction. Both ledgers are append-only and every transfer is idempotent.

The existing `reserve_generation_credits` RPC remains the production entry point used by the approved workflow enqueue path. It first revalidates the owner's current `ai_generation` subscription entitlement. If the job's project has an active shared pool, the reservation is charged to that pool; otherwise, the original personal-wallet implementation is called. A configured pool is authoritative: insufficient shared funds or a monthly spend-cap breach blocks dispatch and never silently falls back to the personal wallet.

The shared pool reservation mirrors the existing reservation identity so approval replay and cancellation continue to use the established contracts. Provider settlement and cancellation release reconcile the project pool reservation and mirror in the same transaction. Monthly spend caps serialize on the project-pool row and count settled actual credits or still-reserved credits for the current calendar month.

This first increment is **project-owner controlled**. It does not yet grant project editors independent cloud-generation permission or per-member spend caps; the existing project owner authorization remains in force. Team-member authorization and attribution are a separate follow-up, not an implied capability. The migration is additive and CI-only until a separately approved staging migration.
