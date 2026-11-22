# Batch 69 — Credit pricing and profitability control centre

## Purpose

Make the Batch 68 non-binding pricing engine usable from the authenticated Financial Command Centre. The workspace now compares the proposed subscription tiers, displays the existing provider rate-card catalogue and submits explicit cost scenarios to the protected calculator endpoint.

## Customer plan assumptions

The interface preserves these proposed monthly test prices without changing the live subscription catalogue:
- Starter Creator — USD 9
- Professional Creator — USD 29
- Studio — USD 79
- Agency — USD 199
- Enterprise — custom quote

These are unvalidated proposals, not published or approved prices. The subscription simulator uses the four numeric plan prices as scenario inputs. It requires the operator to enter measured fixed service cost, measured blended variable cost per credit, payment fee, VAT on that fee and target contribution margin. No default provider cost, payment fee or margin is silently assumed.

## Provider rate-card catalogue

The panel loads `GET /api/admin/finance/model-rate-cards?limit=200`, which is restricted to owner, platform-admin and billing-admin roles. It displays existing records, including provider/model, currency, version, verification status, effective dates and source reference. The catalogue is read-only in this batch. Unverified/legacy records remain visibly distinguished; missing records are not interpreted as zero cost.

## Scenario workflows

### Subscription allowance ceiling

The selected plan's proposed monthly price is sent as integer USD cents to `POST /api/admin/finance/credit-pricing/scenario` with `mode=subscription`. The operator must supply measured monthly fixed cost and positive measured blended variable cost per credit, plus explicit fee and target-margin assumptions. The output is a mathematical maximum allowance, not a recommendation to grant the full ceiling.

### Prepaid credit-pack price floor

The operator supplies currency, pack credit units, measured provider cost, allocated infrastructure cost, expected retry allowance, fixed payment fee, payment processing fee, VAT on that fee and target margin. The output is a minimum sustainable price and per-credit floor. Inputs use currency minor units.

## Safety and release boundaries

- Existing rate-card catalogue is read-only.
- No rate-card rows are seeded, edited or approved.
- No subscription catalogue price, credit allowance, credit pack price or customer entitlement changes.
- No checkout, charge, payment, credit grant, provider job or live provider call is initiated.
- No database migration or schema change.
- No production deployment or paid infrastructure.
- Missing measured cost or fee/margin assumptions block a calculation.
- The UI labels all results as non-binding scenarios and keeps source verification visible.

## External provider price references

These references are public API prices, not Executive Visuals selling prices. They are included for operator awareness only and are not automatically imported into the database:
- Runway Dev Seedance 2.5: 480p $0.20/sec, 720p $0.30/sec, 1080p $0.68/sec and 4K $1.10/sec; video-reference inputs add separate per-second charges and minimum charges apply. See https://dev.runway.com/learn/seedance-2-5-api
- Runway Dev Kling 4.0 list prices: 720p $0.157/sec, 1080p $0.235/sec, 4K $0.549/sec. Input video uses a separate billing rule. A temporary promotion runs through 30 November 2026; do not use promotional rates as the long-term cost baseline. See https://dev.runway.com/learn/kling-4-0-api and https://docs.dev.runwayml.com/guides/pricing/

Prices and model billing rules can change. Before adding a rate-card record, verify the model, resolution, audio options, reference-video duration, minimum charges, currency, source timestamp and effective period.

## Verification

The billing self-service GitHub Actions workflow runs application type-checking, financial API syntax checks, Batch 68 unit economics tests, financial API tests and disposable PostgreSQL integration checks for the preceding billing batches.

## Rollout

Draft branch and draft pull request only. Merge and production release require review of the complete dependency chain and explicit authorization.
