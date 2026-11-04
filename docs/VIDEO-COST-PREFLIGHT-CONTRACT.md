# Unified video-generation cost preflight

**Snapshot date:** 4 November 2026  
**Status:** estimate-only; provider execution remains separately gated.

## Purpose

The shared server-side preflight normalizes published provider pricing into provider credits and, where an explicit conversion basis exists, a clearly labelled monetary estimate before a budget reservation can be evaluated. Estimates are not quotes, invoices, captured charges, or settlement evidence.

## Verified price sources

- Runway Dev: https://docs.dev.runwayml.com/guides/pricing/
- Luma Agents Ray 3.2: https://docs.agents.lumalabs.ai/guides/pricing/

## Supported pricing contracts

| Provider/model | Supported estimate operations | Pricing basis |
|---|---|---|
| Runway models with explicit entries in the dated Runway table | Model-specific generation, editing, extension, reframing and output-format calculations | Published credit rates converted using the documented USD credit basis |
| Luma Ray 3.2 | SDR/HDR/EXR generation, video editing, fixed five-second extension and per-second reframing | Published operation/resolution/duration credit rates; USD uses the documented default list rate of $0.003/credit only |

The estimator rejects unknown providers/models and unsupported combinations. Luma's 360p draft tier is intentionally excluded. HDR generation constraints and the distinct edit/reframe/extend billing bases are enforced by the provider-specific estimator.

## Runway finishing plan builder

The estimate-only `createRunwayVideoFinishingPlan` helper turns verified source media metadata and requested operations into a costed plan for the durable video-finishing pipeline. It supports Magnific video upscale (priced per output frame), Enhance Frame Rate (priced per input second), and Ruby HDR (priced per second with a source megapixel tier). It enforces the cost-aware sequence upscale → retime → HDR, requires post-upscale dimensions for Ruby estimates, and does not execute or authorize provider calls.

## Governance boundaries

- Every result carries provider/model, currency, pricing source, date and calculation formula.
- Luma estimates expose provider credits separately. The USD amount uses the documented default list rate of $0.003 per credit; an account's own plan/contract rate or applicable overage rate may differ. See https://docs.agents.lumalabs.ai/guides/usage/.
- The system must not treat a default-list-rate USD estimate as the customer's settled or contract-specific spend.
- Results are immutable and explicitly marked `billable: false` and `settlementEligible: false`.
- A cost estimate does not enable a provider, create a job, reserve money, or authorize a paid request.
- Finishing-plan steps are explicitly remote and must pass the existing pipeline's approval ID and full-budget checks before any adapter can execute.
- Cloud enqueue still independently enforces the currently enabled execution adapter and budget approval. Luma remains disabled/research-only; this change does not add a Luma execution adapter or activate credentials.
- Pricing must be revalidated against the official provider source before any production budget approval. Promotional rates, taxes, exchange rates and account-specific terms may differ.

## Verification

The shared estimator test suite covers the existing Runway estimate path, Luma Ray 3.2 generation/edit/extend/reframe calculations, unsupported combinations, unknown models and non-billable result invariants. The test is included in the cloud-queue verification command and the full server test suite.


## Cross-provider model routing contract

`server/video-model-router.mjs` implements deterministic, side-effect-free model selection across providers. It consumes candidate records produced by the application after registry lookup and shared cost estimation.

The router applies hard eligibility filters before optimization:
- Provider and model must both be explicitly enabled.
- The provider adapter must be in `ready` state.
- The requested operation, duration, resolution, aspect ratio, audio and seed requirements must be supported.
- A dated USD estimate with a pricing source is mandatory; estimates must remain non-billable and ineligible for settlement.
- Optional hard spend caps, allowlists and denylists are applied before ranking.

Optimization supports cost, measured latency or a validated quality score. Latency and quality are never fabricated: candidates missing the requested metric are excluded. Ties resolve deterministically by estimated cost, measured latency and stable provider/model ID.

The router returns a decision and exclusion reasons only. It does not call provider APIs, reserve funds, create jobs, activate models or bypass the durable queue and approval gates. The current catalogue has no enabled adapters, so a catalogue-derived production request correctly returns `no_eligible_model` until the adapters and release gates are implemented.
