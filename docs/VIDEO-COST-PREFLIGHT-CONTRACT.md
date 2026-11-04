# Unified video-generation cost preflight

**Snapshot date:** 4 November 2026  
**Status:** estimate-only; provider execution remains separately gated.

## Purpose

The shared server-side preflight normalizes published provider pricing into a consistent USD estimate before a budget reservation can be evaluated. Estimates are not quotes, invoices, captured charges, or settlement evidence.

## Verified price sources

- Runway Dev: https://docs.dev.runwayml.com/guides/pricing/
- Luma Agents Ray 3.2: https://docs.agents.lumalabs.ai/guides/pricing/

## Supported pricing contracts

| Provider/model | Supported estimate operations | Pricing basis |
|---|---|---|
| Runway models with explicit entries in the dated Runway table | Model-specific generation, editing, extension, reframing and output-format calculations | Published credit rates converted using the documented USD credit basis |
| Luma Ray 3.2 | SDR/HDR/EXR generation, video editing, fixed five-second extension and per-second reframing | Published operation/resolution/duration list prices |

The estimator rejects unknown providers/models and unsupported combinations. Luma's 360p draft tier is intentionally excluded. HDR generation constraints and the distinct edit/reframe/extend billing bases are enforced by the provider-specific estimator.

## Governance boundaries

- Every result carries provider/model, currency, pricing source, date and calculation formula.
- Results are immutable and explicitly marked `billable: false` and `settlementEligible: false`.
- A cost estimate does not enable a provider, create a job, reserve money, or authorize a paid request.
- Cloud enqueue still independently enforces the currently enabled execution adapter and budget approval. Luma remains disabled/research-only; this change does not add a Luma execution adapter or activate credentials.
- Pricing must be revalidated against the official provider source before any production budget approval. Promotional rates, taxes, exchange rates and account-specific terms may differ.

## Verification

The shared estimator test suite covers the existing Runway estimate path, Luma Ray 3.2 generation/edit/extend/reframe calculations, unsupported combinations, unknown models and non-billable result invariants. The test is included in the cloud-queue verification command and the full server test suite.
