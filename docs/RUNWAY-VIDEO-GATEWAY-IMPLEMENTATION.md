# Runway video gateway — November 2026 model profile update

**Reviewed:** 2026-11-07  
**Gateway:** `server/runway-video-gateway.mjs`

## Newly supported adapter profiles

### Kling 4.0 Flash — `kling_4_flash`

- Text-to-video: 720p, 3–20 seconds, 26,000-character prompt budget.
- Documented text-to-video output dimensions are mapped for landscape, portrait, square and 21:9.
- First-frame image-to-video is supported and follows the first-frame aspect ratio; the adapter omits a forced ratio.
- Native generated audio is represented in the capability profile.
- First-frame image-to-video is currently implemented; additional image/video references and source-video editing are not yet exposed by this adapter.
- The current adapter does not expose separate reference image collections, reference videos, or video-to-video editing despite the upstream model supporting them.

### Gemini Omni 1.2 Flash — `gemini_omni_flash_1.2`

- Text-to-video: 3–15 seconds, 4,000-character prompt limit.
- Exact output pixel ratios are mapped to 360p, 720p, 1080p and 4K tiers.
- Native generated audio is supported and now represented in the capability profile.
- First-frame image-to-video is implemented with the documented pixel ratio mapping. Optional last-frame interpolation, up to five image references in text-to-video, up to three video references, and video-to-video reference/edit/extend modes are not yet exposed by this adapter.
- The adapter currently uses an explicit integer duration (3–15 seconds); it does not yet expose the provider's automatic-duration reservation flow through the video workflow.
- Last-frame, multi-reference, reference-video, source-video edit and extension modes are not exposed by this gateway yet.

## Shared safety and execution

- Provider model IDs are allowlisted in readiness checks.
- Remote execution remains disabled unless server configuration and remote opt-in are both present.
- API credentials are read only on the server.
- Provider task IDs are polled asynchronously; task output URLs must be HTTPS on the provider CDN host; downloads are size-bounded and validated as MP4.
- Fake HTTP tests exercise request payloads, task polling and output validation; CI does not submit paid provider requests.

## Latest upstream API verification (2026-11-07)

The current Runway model catalogue and input guide list these exact model IDs and newer input contracts. In particular, Gemini Omni 1.2 Flash has native audio, first/last-frame interpolation, image/video references, and video-to-video reference/edit/extend modes. Kling 4.0 Flash supports native audio, first-frame image-to-video, reference videos, and video-to-video. These upstream capabilities are **not** implied to be implemented by this narrower adapter; only the implemented subset is advertised.

- https://docs.dev.runwayml.com/guides/models/
- https://docs.dev.runwayml.com/assets/inputs/
- https://docs.dev.runwayml.com/guides/pricing/
- https://docs.dev.runwayml.com/api-details/api_changelog/

## Published-price preflight and billing reservation

The workflow billing boundary now uses the model-specific Runway published-price estimator for the two newly added profiles when platform credit value and markup configuration are present:

- Kling 4.0 Flash: 9.4 Runway credits per output second, with a 29-credit minimum; 5 seconds estimates 47 provider credits.
- Gemini Omni 1.2 Flash: 2 / 7 / 10 / 21 Runway credits per second at 360p / 720p / 1080p / 4K, plus applicable image and input-video charges; 5 seconds at 720p estimates 35 provider credits before references.
- GPT Image 2.6: pricing varies by exact pixel ratio, resolution tier and quality; each reference image adds one credit per output image.

The billing resolver converts the provider estimate into platform credits using the configured credit value and markup. The estimate is stored with the reservation metadata. It remains an estimate, not task-level actual-cost settlement; successful jobs must not be described as reconciled invoices. The production release gate remains blocked until provider usage reconciliation, cancellation/refund behavior and durable ledger acceptance are proven.

## Runway cost evidence and reconciliation boundary

The current Runway API exposes three distinct evidence surfaces:

- Task creation and task detail expose `estimatedCost.credits`; this is a task estimate, not an authoritative final charge.
- `POST /v1/organization/usage` reports credit usage aggregated by UTC day, model and API key. It is useful for daily variance monitoring, but it does not return the task ID needed to settle an individual customer job.
- `GET /v1/organization/webapp/usage` returns per-generation rows for linked Runway web-app workspaces. This is a different billing scope from the API project's direct task usage and must not be used to attribute direct API tasks without a verified join.

Accordingly, daily aggregate reconciliation can flag differences between platform reservations and Runway API usage. It cannot safely settle individual jobs or calculate individual customer refunds. The durable cloud video worker still requires a task-correlated actual-cost resolver; it must remain disabled for Runway until such evidence is available.

Read-only operator command (requires `DB_FILE` or `DATA_DIR` and server-side `RUNWAY_API_KEY`):

```bash
npm run reconcile:runway-usage -- --from=2026-11-01 --before=2026-11-08
```

The end date is exclusive. The command does not write to the database or alter credit balances. It is a daily model-level variance report, not per-task settlement.

Official evidence:
- https://docs.dev.runwayml.com/api/ (Organization → Query credit usage; Organization → List linked workspace usage)
- https://docs.dev.runwayml.com/usage/workspace-reporting/
- https://docs.dev.runwayml.com/guides/pricing/

## Commercial and release gates

- Video estimates are separate from authoritative provider settlement. Do not invoice customers from `estimatedCostCredits`.
- The customer credit reservation, provider actual-cost reconciliation, ambiguous-submission operator workflow and refund path must be accepted end-to-end before selling these profiles.
- The worker currently returns one MP4 output. Multi-output batch fan-out and video-to-video modes remain separate work.
- Staging acceptance must verify private source-asset resolution, private output ingestion, ownership isolation, retries, cancellation semantics, usage ledger and billing reconciliation.
- Do not enable production execution based only on a passing CI build.

## Official sources

- Model catalogue: https://docs.dev.runwayml.com/guides/models/
- Input limits and model-specific modes: https://docs.dev.runwayml.com/assets/inputs/
- Pricing and model-specific billing: https://docs.dev.runwayml.com/guides/pricing/
- API reference: https://docs.dev.runwayml.com/api/
