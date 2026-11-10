# Batch 46 — Financial Scenario Intelligence

## Delivered scope

Batch 46 adds a deterministic monthly scenario calculation engine and connects it to protected, persistent Financial Command Centre workflows.

### Calculation model

- Monthly revenue path: prior-month revenue × (1 + growth − churn) + explicitly supplied new revenue.
- Variable costs use the observed baseline variable-cost ratio and an explicit scenario adjustment.
- Fixed costs compound using the supplied fixed-cost growth assumption.
- Net cash flow separates cash collection, variable costs, fixed costs and capex.
- Discounted net cash flow (cash collections less variable costs, fixed costs and capex), ending cash, minimum closing cash and months-to-positive-cash are returned by month.
- Break-even revenue is calculated from contribution margin and explicitly unavailable when contribution margin is non-positive.
- Downside/base/upside cases use clearly labelled illustrative shocks.
- One-factor sensitivity covers revenue growth, variable-cost rate, fixed-cost growth and churn.
- Decision comparisons use explicitly supplied success probabilities and one-time investments against discounted net cash flow (NPV), not revenue or contribution margin alone.

### Protected API and persistence

- GET /api/admin/finance/scenarios lists the authenticated finance administrator's saved snapshots.
- POST /api/admin/finance/scenarios validates the request, runs the calculation server-side and persists the result.
- The authenticated administrator identity is supplied by the session, never accepted from the request body.
- Snapshots preserve inputs, outputs, evidence references, model version, timestamps and SHA-256 digests.
- Actor-scoped idempotency returns the original snapshot on replay and rejects a reused key with different payload hashes.
- The snapshot table has RLS enabled, no direct client access, and a database trigger rejecting update/delete operations.
- Each save is recorded in the existing financial administrator audit ledger.

### Financial Command Centre UI

- Interactive scenario form for currency, period, opening cash, revenue, costs, capex, growth, churn, collections, discount rate, horizon and evidence coverage.
- Verified baseline loader reads the latest available-cash snapshot, selected-month subscription MRR and same-month direct service-cost events by currency, returning the exact source identifiers.
- Baseline semantics are explicit: MRR is not cash collected, direct service costs are not total variable costs, and fixed costs/capex are never inferred from missing records.
- Server-calculated scenario save and refresh actions.
- Saved snapshot table with confidence, ending cash and break-even status.
- Aurora visual treatment consistent with the existing Batch 45 design system.

## Evidence and safety semantics

- Monetary values are integer minor units and a single currency per model; no FX conversion or currency blending.
- Evidence months, source coverage and data age are explicit. Confidence is an evidence-coverage label, not a statistical confidence interval.
- Default downside/upside shocks are illustrative; users must replace them with approved assumptions before decision use.
- Evidence references can be loaded from recorded cash, subscription and direct service-cost ledgers; user-supplied references remain unverified identifiers. The baseline endpoint does not invent missing amounts.
- Scenario snapshots are immutable evidence records, not approved budgets, accounting entries or instructions to spend.
- The engine does not mutate payment, subscription, cost, customer or acquisition ledgers.
- No payments, funding drawdowns, price changes, acquisition spend or provider operations are triggered.

## Verification

- node --test server/tests/financial-scenario-intelligence.test.mjs server/tests/financial-scenario-api.test.mjs
- Disposable PostgreSQL integration: scripts/financial-scenario-snapshots-postgres-integration-batch-46.sql
- CI applies the Batch 46 migration after Batch 45 and verifies idempotency and append-only persistence.
- The complete repository build continues to include the scenario calculation and API tests.

## Release boundary

Batch 46 remains a draft until CI executes successfully, SQL integration is verified, assumptions and formulas receive review, and the staged Financial Command Centre is inspected. No production migration, deployment or merge is authorized by this implementation.
