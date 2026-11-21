# Gemini Omni 1.2 Flash — Vertex worker integration

Status: Vertex transport, model-scoped durable interaction records, worker composition, model-specific token pricing, lease-fenced private GCS output ingestion, and fail-closed provider gates are implemented on this feature branch. Staging IAM validation, real credential verification, provider smoke tests, and end-to-end acceptance remain incomplete.

## Why this is a separate integration

Gemini Omni 1.2 Flash is listed as a GA model on the Gemini Enterprise Agent Platform Interactions API. The supported model ID is `gemini-omni-1.2-flash`. The Vertex Interactions API currently documents a project-scoped `v1beta1` endpoint (do not substitute the unrelated general Vertex `v1` API surface):

`POST https://aiplatform.googleapis.com/v1beta1/projects/{PROJECT_ID}/locations/global/interactions`\n\nThe video-generation guide's project-scoped status retrieval is `GET https://aiplatform.googleapis.com/v1beta1/projects/{PROJECT_ID}/locations/global/interactions/{INTERACTION_ID}`. Background cancellation uses the documented Interactions HTTP cancellation resource `POST https://aiplatform.googleapis.com/v1beta1/interactions/{INTERACTION_ID}/cancel` with an empty request body.

This differs from the existing Gemini Developer API 1.1 worker, which uses the Generative Language API, API-key authentication and Google Files resources. Do not point the 1.2 model at the 1.1 client or assume a Google Files URI is a Vertex output.

## Current implementation

- `server/google-omni-vertex-client.mjs`: OAuth/ADC transport for project-scoped Vertex Interactions API requests. Requests are stored and run in the background. It uses the documented project-scoped GET status route and the Interactions HTTP cancel route. URI delivery writes into a deterministic per-job GCS prefix.
- `server/google-omni-vertex-output-ingestion.mjs`: downloads only objects under the exact configured bucket/prefix/job/request hash and publishes through the existing private, lease-fenced Cloud Asset repository.\n- `server/google-omni-vertex-cloud-video-adapter.mjs`: binds approved plans, durable submission records, status polling, cancellation, private output ingestion and usage settlement to the cloud worker contract.\n- `server/google-omni-vertex-pricing.mjs`: uses the published Omni 1.2 token rate card, reserves the full 131,072-input / 260,640-output ceiling, includes thought tokens in text-output billing, and rejects inconsistent or over-limit usage. The maximum preflight reservation is $3.324288 before customer-credit conversion; it is a ceiling, not a per-video price.\n- `server/cloud-video-provider-worker-composition.mjs`: registers Omni 1.2 separately behind shared Google gates, Vertex-specific gates, a verified Google Cloud connection and a live connection verifier.\n- `server/cloud-video-generation-job-executor.mjs`: now passes the active worker lease assertion and abort signal into private output ingestion; failed Omni 1.2 tasks retain their reservation for usage reconciliation.
- `server/google-video-interaction-repository.mjs`: supports a caller-supplied allowlist for the 1.1 Files API URI contract and the 1.2 private GCS output URI contract. The default remains 1.1 only.
- `supabase/migrations/20261121100000_google_omni_vertex_interaction_records.sql`: extends the existing model and output-URI constraints without changing existing 1.1 records. It is source-controlled only and must be applied only after isolated staging review.
- `server/tests/google-omni-vertex-client.test.mjs` and `server/tests/google-omni-vertex-output-ingestion.test.mjs`: request, authorization, path confinement, download, content-type, size and lease tests.

The worker integration is now composed but remains disabled by default. The interaction repository still defaults to the 1.1 model allowlist; the Vertex worker explicitly requests the 1.2 allowlist. A real Google Cloud connection, private GCS IAM, approved plan callback and all explicit provider gates are required before remote execution can be registered.

## Configuration prerequisites — do not add until staging is approved

The worker will require:

- `GOOGLE_CLOUD_PROJECT`: Google Cloud project ID.
- `GOOGLE_OMNI_OUTPUT_BUCKET`: dedicated private GCS bucket.
- `GOOGLE_OMNI_OUTPUT_PREFIX`: optional prefix; defaults to `executive-visuals/omni-12`.\n- `GOOGLE_OMNI_VERTEX_VIDEO_ENABLED=true` and `GOOGLE_OMNI_VERTEX_VIDEO_ALLOW_REMOTE=true`, in addition to `GOOGLE_OMNI_VIDEO_ENABLED=true` and `GOOGLE_OMNI_VIDEO_ALLOW_REMOTE=true`.\n- `GOOGLE_OMNI_VERTEX_CONNECTION_STATUS=connected` plus a live `googleOmniVertexAssertConnection` callback.\n- `googleOmniVertexPreparePlan`: an owner/project-scoped planner that returns an explicitly approved `gemini-omni-1.2-flash` plan.\n- `GOOGLE_CLOUD_PROJECT` and `GOOGLE_OMNI_OUTPUT_BUCKET` must be set before the default client/ingestor can be constructed.
- Application Default Credentials for the Vertex AI and Cloud Storage APIs. Prefer workload identity/federation where the hosting platform supports it; otherwise use a protected service-account credential mechanism. Never commit credentials or expose them to browser code.

The Google identity that submits Vertex interactions must have the minimum Vertex AI permissions required to call Interactions API. The Vertex model service identity must be authorized to create objects in the configured output prefix. The worker identity must have read-only access to that prefix. Do not grant project-wide Storage Admin merely to make the integration work.

The bucket must be private. Do not use public object ACLs, public buckets, or browser-accessible GCS URLs. Keep object download and asset publication server-side.

## Request and output contract

- Model: `gemini-omni-1.2-flash`.
- Native generation/edit duration: 3–15 seconds; first/last-frame interpolation and extension have narrower documented limits.
- Output resolutions: 360p, 720p, 1080p and 4K; cost preflight must reject any resolution without a verified rate card.
- URI output requires a `gcs_uri` destination inside a `response_format` list. The documented request shape uses an array of response-format objects, not a single object.
- Video requests must specify the operation in `generation_config.video_config.task` (for example, `text_to_video`); the planner must select the task matching its authorized inputs. The worker generates that destination from its own bucket/prefix and the durable job ID + request hash; callers cannot supply an arbitrary GCS path.
- The Vertex interaction ID and output URI must be durably associated with the exact owner, project, job, request hash and current worker lease.
- Downloaded output must pass byte limits, MP4 content-type checks, SHA-256 calculation and private asset publication before the job can complete.

## Pricing and billing gate

Google's November 5, 2026 GA announcement states $0.07 per second for 720p video. The current Agent Platform pricing table still lists token-rate rows for Gemini Omni Flash / Omni 1.1 rather than a complete 1.2 Vertex usage schedule. Treat $0.07/second as a published 720p reference price only, not as proof of all-resolution or input-modality billing semantics.

Do not enable 1.2 paid execution until the exact Vertex pricing dimensions for input modalities, text output, video output, output resolution, and returned usage evidence are verified against the current Google Cloud rate card. Do not settle customer credits using a flat $0.07/second estimate where actual usage evidence is required. The provider must remain disabled until the preflight reservation and actual-usage resolver are model-specific, tested, and reconciled.

## Activation checklist

1. Review and merge transport tests only after CI passes.
2. Add a separate Vertex 1.2 adapter and model-specific usage resolver.
3. Integrate GCS private asset inputs using the existing GCS mirror/resolver with owner/project authorization.
4. Compose the Vertex adapter into the durable worker without changing the 1.1 path.
5. Verify bucket IAM and service identity in staging.
6. Run staging-only text-to-video, image/reference-to-video, edit, extension and recovery tests under an explicit budget ceiling.
7. Verify actual provider usage, customer-credit settlement, private asset lineage and deletion/retention behavior.
8. Only then request explicit approval for production configuration or activation.

## Official references

- Google Cloud Interactions API: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api
- Gemini Omni 1.2 model page: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/omni-1-2-flash
- Video generation request/response and GCS URI delivery: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-an-image
- Gemini Omni 1.2 launch and published 720p price: https://cloud.google.com/blog/products/ai-machine-learning/gemini-omni-1-2-flash-generally-available
- Google Cloud Generative AI pricing: https://cloud.google.com/model-garden/pricing\n- Vertex Interactions HTTP get/cancel reference: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1beta1/projects.locations.interactionsHttp/get
- Google Cloud Omni 1.2 GA pricing announcement: https://cloud.google.com/blog/products/ai-machine-learning/gemini-omni-1-2-flash-generally-available
