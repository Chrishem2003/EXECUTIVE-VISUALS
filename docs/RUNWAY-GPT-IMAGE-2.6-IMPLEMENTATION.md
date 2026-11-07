# Runway GPT Image 2.6 adapter — implementation and release gates

**Reviewed:** 2026-11-07  
**Models:** `gpt_image_2_6_flare`, `gpt_image_2_6_sunburst`  
**Provider API:** `POST /v1/text_to_image`, task polling via `GET /v1/tasks/{id}`

## Implemented

- Separate Runway image adapter with server-side API key handling and fixed API version header.
- Strict allowlist for GPT Image 2.6 Flare and Sunburst.
- Prompt limit of 32,000 characters.
- Exact allowlist of all 30 documented pixel dimensions across 1K, 2K and 4K, plus `auto`.
- Quality, reasoning effort and background controls.
- Up to 16 project-owned reference images; each image is checked for ownership, path containment, byte size, media type, file signature and SHA-256 before encoding.
- Provider task creation, bounded polling, strict CloudFront output-host validation, bounded streaming download and PNG signature validation.
- Output stored by the existing generated-image asset writer; model usage is recorded through the existing workflow ledger.
- Workflow image nodes retain the completed upstream human-approval requirement.
- Provider readiness checks hide credentials and fail closed for unknown model IDs.
- Tests use fake HTTP responses only; no paid provider request is sent by CI.

## Pricing contract

Runway Dev charges one credit per US cent. GPT Image 2.6 price per image is based on the exact ratio size, resolution tier and quality; add one credit per reference image per generated output. Reasoning effort does not change price. With `ratio: "auto"`, reserve the 4K square price and settle against the rendered tier. The local estimator is non-billable and cannot be used as settlement evidence.

The exact pricing tables and 30 supported sizes are encoded in `server/runway-image-pricing.mjs`. Unsupported or approximate dimensions are rejected instead of silently mapped to a neighboring aspect ratio.

## Workflow constraints still open

- The workflow executor currently requests one output per job because the existing node output and asset persistence contract is singular. The provider API supports 1–10 outputs; multi-output fan-out and atomic asset registration need a separate change.
- The current workflow node exposes a single output asset ID. Multi-output support must define stable ordering, partial-failure cleanup, usage attribution and downstream batch semantics.
- Provider task estimated/actual cost metadata is recorded only as provider metadata returned by the adapter. It is not yet reconciled against the platform's customer credit reservation and final invoice.
- A timed-out submission is marked ambiguous; automatic retry is intentionally not attempted. An operator reconciliation path for Runway image submissions remains to be added.
- The adapter downloads provider output into memory before the existing local asset writer. The production private-object-storage ingestion path and streaming object upload acceptance are still required before paid multi-user production.
- The adapter is not enabled by default. Set `IMAGE_GATEWAY_PROVIDER=runway`, `IMAGE_GATEWAY_ENABLED=true`, `IMAGE_GATEWAY_ALLOW_REMOTE=true`, and a server-side `RUNWAY_API_KEY` or `RUNWAYML_API_SECRET` only after approving the cost and data-processing boundary.

## Official sources

- Model catalogue: https://docs.dev.runwayml.com/guides/models/
- Image input rules: https://docs.dev.runwayml.com/assets/inputs/
- API reference: https://docs.dev.runwayml.com/api/
- Pricing: https://docs.dev.runwayml.com/guides/pricing/
- Changelog: https://docs.dev.runwayml.com/api-details/api_changelog/
