# Studio engines: neural enhancement and presenter video

These two engines fill the gaps left by the provider registry. Text, image, video, speech and transcription keep their own adapters; local FFmpeg handles deterministic finishing. Everything here is **disabled by default** and talks only to a gateway you operate.

## What runs where

| Job | Route | Notes |
|---|---|---|
| `studio.enhance` | `POST /api/studio/runs` | Operations: upscale, enhance, denoise, restore, stabilize, interpolate, remove-background, remove-watermark |
| `studio.avatar` | `POST /api/studio/runs` | Script or narration audio, plus a presenter reference in your gateway |
| Catalog | `GET /api/studio/capabilities` | The browser builds its forms from this, so client and server share one spec |

Workflow nodes `media.stabilize` and `image.remove-background` call the same engine, only after an approved ancestor.

## Safeguards

- HTTPS only (loopback allowed), remote use needs `<ENGINE>_GATEWAY_ALLOW_REMOTE=true`, no redirects, keys sent only to the gateway origin.
- Result URLs on another origin are fetched only if the host is in `<ENGINE>_GATEWAY_OUTPUT_HOSTS`.
- Size caps and file-signature checks on every result.
- Presenter jobs need a project character whose consent covers `face-animation` (and `voice` with a voice reference). Consent is checked when the request is made and again when the job runs, so withdrawing it stops queued work.
- Watermark removal needs an explicit rights attestation, written to the audit trail.
- Every remote request reserves a slot against `REMOTE_AI_DAILY_REQUEST_LIMIT` and is recorded in the usage ledger.
- Gateway configuration errors mark the job `blocked` rather than retrying.

## Gateway contract

Enhancement: multipart `POST {url}/enhance`, status at `{url}/jobs/{id}`. Presenter: JSON `POST {url}/avatar/videos`, status at `{url}/avatar/videos/{id}`. A reply may carry the file directly, a result URL, inline base64, or a job id to poll. See `.env.example` for variables.

## Verification

`node --test server/tests/studio.test.mjs` runs against local mock gateways only. No live provider has been called.
