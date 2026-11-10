# Executive Visuals — Batch 12 financial command centre

**Status:** implementation in a stacked development branch; not merged or deployed.  
**Branch:** `feat/financial-command-centre-batch-12`  
**Base:** `feat/financial-intelligence-api-integration` (Batch 11)  
**Safety:** billing remains disabled by default; migration is unapplied; no live Flutterwave calls, merchant setting changes, production database changes, merges or deployments were performed.

## Delivered in this batch

### Admin analytics API and database aggregates
- `GET /api/admin/finance/command-centre` — role-gated, database-side financial aggregates with bounded customer/risk lists and date-range validation.
- `GET /api/admin/finance/customer?ownerId=...` — admin-only customer financial profile, payment, subscription, refund, payment-attempt and chargeback history.
- `GET /api/admin/finance/audit` — recent immutable admin audit records.
- `GET /api/admin/finance/export?kind=...` — bounded payment, refund, subscription, chargeback and settlement report datasets; exports are audit logged.
- `POST /api/admin/finance/settlements/reconcile` — retrieves Flutterwave V4 settlements and settlement details, matches complete provider charge lists against verified local charges, and preserves unresolved cases for review.
- `POST /api/admin/finance/reconciliation-exceptions/resolve` — reason-required exception resolution with an audit event.

### Financial command centre UI
- New Financial command centre workspace under Manage.
- Currency-separated gross, refunds, net collected, MRR, ARR, successful and failed payment metrics.
- Revenue and active subscription count by plan tier.
- Refund and chargeback monitoring, failed-payment recovery metrics and customer financial profiles.
- Review-only suspicious-transaction indicators with drill-through to customer financial records.
- CSV export controls and settlement reconciliation controls.
- Audit trail viewer. Unauthorized accounts receive server-side denial; hiding a navigation item is not treated as authorization.

### Financial definitions
- **MRR:** active/past-due subscription run rate, with yearly subscriptions normalized to one twelfth of their committed amount. Free plans and one-time purchases are excluded.
- **ARR:** MRR × 12. This is a forward run-rate metric, not cash received or a forecast guarantee.
- **Gross revenue:** verified successful payments in the selected period.
- **Refunds:** provider-confirmed successful refunds in the selected period.
- **Net collected:** gross successful payments less confirmed refunds. Provider fees are shown separately; chargeback exposure is not silently netted into revenue.
- **Customer lifetime value:** realized historical successful payment value less confirmed refunds, by customer and currency. It is not a predictive future-LTV model.
- **Currencies:** amounts are never summed across currencies. UGX uses zero decimal places; common zero- and three-decimal currencies are handled explicitly for settlement amounts.
- **Fraud indicators:** heuristic review signals only (e.g. repeated failed payments, unusually rapid successful payments, high refund-value ratio, open/lost disputes). They are not a fraud verdict, automatic account block or automated refund.

### Flutterwave settlement reconciliation
Flutterwave V4 documents list and retrieve settlement endpoints, and settlement details include gross/net amounts, fees, refunds, chargebacks, status, destination and charge-line details. The integration:
1. retrieves a bounded date-filtered settlement list;
2. fetches each settlement detail;
3. requires the returned charge list to be complete before comparing it;
4. matches every provider charge ID to a successful local Flutterwave transaction in the same currency;
5. compares provider gross and (when locally recorded for every charge) provider fees;
6. persists the provider settlement snapshot and opens exceptions for exact amount mismatches.

Settlement charge details are paginated independently (V4 retrieve-settlement reference supports page/size, up to 50 rows per page). The importer reads up to 20 pages; if provider metadata or charge counts show that the line-item list is incomplete, or a local charge/fee match is incomplete, the settlement remains **review_required**. The application does not manufacture a match from aggregate estimates.

Official provider references:
- https://developer.flutterwave.com/v4.0/docs/settlements
- https://developer.flutterwave.com/v4.0.0/docs/refunds
- https://developer.flutterwave.com/v4.0/docs/chargebacks-1
- https://developer.flutterwave.com/v4.0/docs/webhooks

## Security and audit controls
- All new admin routes check `platform_admins` server-side; only owner, platform_admin and billing_admin roles qualify. Support is denied.
- Admin aggregates are calculated in a security-definer SQL function which independently validates the actor role.
- Settlement ingestion and reconciliation exception resolution use service-role-only RPCs and actor-role validation.
- CSV/data exports, settlement reconciliation, exception resolutions, refund initiation and customer financial-profile views write reason-bearing audit events.
- Financial audit rows are append-only; update/delete attempts are rejected by a database trigger.
- Reconciliation resolution requires a reason. Customer records remain owner-scoped for customer-facing routes; admin profiles are accessible only through the privileged server.
- No secrets, payment credentials, full card data or mobile-money PINs are returned to the browser.

## Validation added
- `server/tests/financial-command-centre.test.mjs`: admin role enforcement, dashboard RPC argument/date behavior, owner-specific customer profile queries and audit-logged bounded exports.
- Disposable PostgreSQL workflow now applies the Batch 12 migration and asserts MRR/ARR, tier aggregation, realized LTV, settlement persistence and audit immutability.
- The billing quality workflow now triggers for this Batch 12 branch and runs TypeScript typecheck, server syntax checks, SQL integration and the financial API tests.

## Explicit remaining gates
1. Run exact-head GitHub Actions; do not treat source creation as passing CI.
2. Fix any SQL/type/test failures found by disposable PostgreSQL and full TypeScript checks.
3. Apply the ordered migration chain to isolated Supabase staging only, then verify RLS and the real authenticated admin role.
4. Validate Flutterwave V4 settlement pagination/line-item completeness against an approved merchant sandbox account. Sandbox settlements are not eligible for actual payout settlement; the provider documents settlement eligibility as live-account only.
5. Add a complete chargeback evidence upload/submission workflow and PDF invoice generation/private signed download as follow-on work; Batch 12 currently monitors chargeback exposure and case status but does not claim evidence submission is complete.
6. Confirm Uganda V4 UGX MTN/Airtel merchant sandbox acceptance before any payment activation. No automatic MoMo debit is implemented.
7. Keep billing disabled until staging acceptance, merchant approval, spend/abuse controls, backups and operator approval are complete.

## Rollout boundary
No production migration, live payment, refund, provider setting change, merge or deployment is authorized by this branch. PR must remain draft until exact-head CI and isolated staging acceptance pass.