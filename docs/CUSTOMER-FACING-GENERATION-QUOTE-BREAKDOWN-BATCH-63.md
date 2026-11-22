# Batch 63 — Customer-facing generation quote breakdown

**Status:** implementation committed; automated verification pending.  
**Base:** Batch 62 provider resolution capability gate.  
**Scope:** expose the server-calculated provider estimate and customer-credit quote in the storyboard generation-readiness panel before any budget approval or submission.

## User-visible change

After a customer runs the storyboard's generation-readiness check, the result panel now displays:
- the server-computed provider-cost estimate and currency;
- the total customer credits calculated by the configured server-side pricing policy;
- a per-shot breakdown pairing provider amount and customer credits by stable shot ID;
- provider, model and duration for each priced shot;
- the policy basis when supplied by the server.

The rendering uses DOM nodes and `textContent`, not interpolated HTML. Per-shot credit values are matched by shot ID rather than array position, so a changed ordering cannot silently attach the wrong price to a shot.

If customer-credit pricing is unavailable or the response is incomplete, the panel explicitly says no fallback price has been assumed. It does not invent a price or enable approval.

## Financial boundaries

The displayed numbers remain forecasts. The panel explicitly states that no provider task was submitted and no customer credits were reserved or deducted. Actual provider invoices can differ from estimates. The existing server-side gate continues to block direct storyboard approval while atomic customer-credit reservation and authoritative provider-usage settlement are pending.

This batch does not change subscription prices, monthly allowances, the customer-credit conversion policy, or payment behavior.

## Verification

- Adds a regression test for safe quote rendering, per-shot ID matching, missing-policy behavior and forecast-only language.
- Adds the preflight test to the financial intelligence workflow.
- Existing provider cost and customer-credit calculation tests remain in the same workflow.

## Safety

No provider requests, paid jobs, wallet mutations, credit reservations/deductions/grants, payment activation, schema migrations, production configuration, merges or deployments.
