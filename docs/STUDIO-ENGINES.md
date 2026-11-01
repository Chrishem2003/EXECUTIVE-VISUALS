# Studio engines: enhancement, transforms, presenter video, lip-sync and local finishing

These two engines fill the gaps left by the provider registry. Text, image, video, speech and transcription keep their own adapters; local FFmpeg handles deterministic finishing. Everything here is **disabled by default** and talks only to a gateway you operate.

## What runs where

| Job | Route | Notes |
|---|---|---|
| `studio.enhance` | `POST /api/studio/runs` | Operations: upscale, enhance, denoise, restore, stabilize, interpolate, remove-background, remove-watermark |
| `studio.avatar` | `POST /api/studio/runs` | Script or narration audio, plus a presenter reference in your gateway |
| `studio.transform` | `POST /api/studio/runs` | Extend, restyle, camera move, object removal, time/weather change |
| `studio.lipsync` | `POST /api/studio/runs` | Source video + new audio; needs `lip-sync` consent for the person on screen |
| `media.speed`, `media.fade`, `media.motion`, `media.silence-trim`, `media.mux`, `media.brand` | `POST /api/jobs` | Local FFmpeg finishing, no provider; a second asset (audio or logo) is checked at submit time |
| Catalog | `GET /api/studio/capabilities` | The browser builds its forms from this, so client and server share one spec |

Workflow nodes `media.stabilize`, `image.remove-background`, `video.extend`, `video.restyle`, `media.remove-object`, `avatar.generate` and `voice.lipsync` call the same engines, only after an approved ancestor. Local finishing nodes (`media.speed`, `media.fade`, `media.motion`, `media.silence-trim`, `media.mux`/`video.add-audio`, `media.brand`) need no approval because nothing leaves the server.

## Dubbing as a workflow

There is no single dubbing button. Chain the existing nodes: transcribe, translate captions, speak the translation, add the new audio to the video, then (for on-camera speakers with consent) lip-sync.

## Safeguards

- HTTPS only (loopback allowed), remote use needs `<ENGINE>_GATEWAY_ALLOW_REMOTE=true`, no redirects, keys sent only to the gateway origin.
- Result URLs on another origin are fetched only if the host is in `<ENGINE>_GATEWAY_OUTPUT_HOSTS`.
- Size caps and file-signature checks on every result.
- Presenter jobs need a project character whose consent covers `face-animation` (and `voice` with a voice reference). Consent is checked when the request is made and again when the job runs, so withdrawing it stops queued work.
- Watermark removal needs an explicit rights attestation, written to the audit trail.
- Every remote request reserves a slot against `REMOTE_AI_DAILY_REQUEST_LIMIT` and is recorded in the usage ledger.
- Gateway configuration errors mark the job `blocked` rather than retrying.

## Gateway contract

Enhancement, transform: multipart `POST {url}/enhance` or `{url}/transform` (fields `model`, `operation`, `params`, `file`), status at `{url}/jobs/{id}`. Lip-sync: multipart `POST {url}/lipsync` (fields `model`, `params`, `video`, `audio`), status at `{url}/jobs/{id}`. Presenter: JSON `POST {url}/avatar/videos`, status at `{url}/avatar/videos/{id}`. A reply may carry the file directly, a result URL, inline base64, or a job id to poll. See `.env.example` for variables.

## Verification

`node --test server/tests/studio.test.mjs` runs against local mock gateways only. No live provider has been called.
