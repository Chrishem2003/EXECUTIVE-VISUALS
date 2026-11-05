# Kie Seedance 2.0 Provider Adapter

**Milestone:** P1.6 — Multi-provider media execution  
**Status:** Adapter, private input resolution, dated preflight pricing, task-credit settlement, enqueue policy and PostgreSQL regression coverage implemented on a draft branch. Provider remains disabled by default.  
**No paid provider calls are made by construction, tests or catalog registration.**

## Execution path

1. The creative timeline creates a reviewed shot request.
2. The existing budget approval flow binds an owner, project, exact provider/model, request hash, currency and maximum amount.
3. The enqueue boundary checks the Kie-specific remote flags and verifies a conservative provider price floor.
4. The hosted worker prepares the private input through the owner/project-scoped asset repository.
5. A short-lived signed URL is issued only for approved private image assets; caller-supplied URLs are rejected.
6. The Kie client submits one asynchronous task and persists the returned task ID through the existing submission ledger.
7. The worker polls task status at a five-second minimum interval.
8. On success, the output is downloaded through the shared host-allowlisted private ingestor, media-validated and registered in private storage.
9. Budget settlement requires the provider task's reported `creditsConsumed` plus an explicit account-specific `KIE_USD_PER_CREDIT`. Missing usage or an invalid conversion blocks settlement for review.

## Initial supported contract

- Exact model: `bytedance/seedance-2`.
- Text-to-video and image-guided video.
- First frame, or first plus last frame.
- Up to nine private image references.
- 5–15 second output.
- Provider-default (720p), 480p, 720p, 1080p and 4K (mapped from `2160p`).
- Native generated audio by default; explicit `none` is supported.
- MP4 output.
- Aspect ratios: 16:9, 9:16, 1:1, 4:3, 3:4 and 21:9.

Video/audio references, negative prompts, seeds, motion-reference inputs and edit/extend operations are deliberately rejected in this first adapter release. Kie supports additional multimodal reference modes, but those require duration-aware asset inspection, expanded normalized request contracts and corresponding price reservations before enabling them.

## Price and settlement

The dated 2026-11-05 Kie list-price snapshot for Seedance 2.0 uses the following no-video-input rates:

| Output | USD / second | 5-second estimate |
|---|---:|---:|
| 480p | $0.095 | $0.475 |
| 720p | $0.205 | $1.025 |
| 1080p | $0.510 | $2.550 |
| 4K | $1.040 | $5.200 |

Kie publishes lower rates for video-reference mode, billed on reference-video seconds plus output seconds. That mode is not enabled in this adapter release. Preflight estimates are reservations, not settlement evidence. The actual resolver uses task-reported credits and the account's configured effective USD-per-credit rate; Kie top-up bonuses can change that effective rate.

## Server configuration — disabled by default

Only set these on a protected staging worker after the account, billing rate, output host and approval policy have been reviewed:

- `KIE_API_KEY`: server-side secret only; never expose it to the browser.
- `KIE_SEEDANCE_MODEL=bytedance/seedance-2`.
- `KIE_USD_PER_CREDIT`: verified effective USD value for one account credit.
- `KIE_VIDEO_ENABLED=true`.
- `KIE_VIDEO_ALLOW_REMOTE=true`.
- Existing global gates `VIDEO_GATEWAY_ENABLED=true` and `VIDEO_GATEWAY_ALLOW_REMOTE=true`.
- Add only the verified Kie output hostname to the private output ingestor's exact host allowlist.

The worker will not register the Kie adapter unless all global and provider-specific gates are true and the account credit conversion is present. The catalog remains non-selectable until release approval. Never enable production flags as part of this draft.

## Safety and failure handling

- One-shot task creation with durable task ID ledger; ambiguous submission outcomes are quarantined rather than retried blindly.
- No direct user-supplied URL fetches; private image references are authorized against owner/project scope and signed just before submission.
- Reject unsafe hosts, non-HTTPS URLs, malformed task IDs and invalid provider responses.
- Kie task outputs must pass the shared output-host allowlist, private ingestion and media validation.
- Task-reported credits are mandatory for settlement; estimates are never substituted for actual usage.
- Explicit budget approval and reservation are required before a paid task can be enqueued.
- No automatic retry of a paid task after an ambiguous submission outcome.

## Official provider references

- API contract: https://docs.kie.ai/market/bytedance/seedance-2
- Model and price card: https://kie.ai/seedance-2-0?model=bytedance/seedance-2
