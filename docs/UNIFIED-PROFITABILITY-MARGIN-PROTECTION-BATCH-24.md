# Batch 24 — Unified Profitability & Margin Protection

## Delivered

- Versioned, append-only customer/global margin policies with currency-specific thresholds and effective dates.
- Customer-specific policies override global defaults; overlapping policy windows are rejected.
- Idempotent margin evaluation against the latest captured subscription revenue snapshot and Batch 20's directly attributed service-cost ledger.
- Immutable margin alert evidence with period, customer, currency, MRR, direct costs, contribution, observed margin and policy thresholds.
- Idempotent in-app notification outbox records for newly created alerts.
- Protected admin APIs to create policies, evaluate margins and list alert history.
- Financial Command Centre controls to create policies, evaluate customers and review alert/outbox status.
- Integration coverage for policy replay, low-margin detection, duplicate evaluation suppression and pending outbox delivery.
- CI applies the migration and runs the existing PostgreSQL integration suite.

## Endpoints

- `POST /api/admin/finance/margin-policies`
- `POST /api/admin/finance/margin-alerts/evaluate`
- `GET /api/admin/finance/margin-alerts?limit=50`

Policy scopes are `global` or `customer`. Every policy is currency-specific and must define at least one threshold: minimum gross-margin percentage or minimum contribution in currency minor units.

## Accounting and safety boundaries

- The evaluator uses the existing Batch 20 profitability calculation; it does not invent revenue or allocate shared overhead.
- AI usage and worker resource-metering events from Batches 21–23 are not automatically added to customer contribution until they are reconciled into the service-cost ledger. This avoids double-counting invoice costs.
- Alert evaluation does not modify customer charges, subscriptions, provider credentials, provider/model routing or production configuration.
- Notification rows are created as `pending` in the in-app outbox. External email, SMS and chat delivery are not implemented in this batch.
- Alert and policy evidence is append-only. Policy changes require a new effective-dated version; overlapping versions are rejected.
- Margin results are management-accounting signals, not statutory or audited financial statements.

## Validation

The PostgreSQL integration suite checks policy idempotency, customer-level low-margin detection, idempotent repeat evaluation and pending in-app outbox evidence. The GitHub Actions run must pass before this draft is considered validated.

## Rollout

Draft PR only. Do not merge, apply migrations to production, deploy, change customer billing, enable external notifications or alter provider routing without separate review and explicit approval.
