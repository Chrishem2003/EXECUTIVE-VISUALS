# Gemini Omni 1.2 Flash — Vertex worker integration

Status: transport and private-output ingestion implemented on a feature branch; worker composition and staging activation are not yet complete.

## Why this is a separate integration

Gemini Omni 1.2 Flash is listed as a GA model on the Gemini Enterprise Agent Platform Interactions API. The supported model ID is `gemini-omni-1.2-flash`. The Vertex Interactions API uses a project-scoped endpoint:

`POST https://aiplatform.googleapis.com/v1beta1/projects/{PROJECT_ID}/locations/global/interactions`

This differs from the existing Gemini Developer API 1.1 worker, which uses the Generative Language API, API-key authentication and Google Files resources. Do not point the 1.2 model at the 1.1 client or assume a Google Files URI is a Vertex output.

## Current implementation

- `server/google-omni-vertex-client.mjs`: OAuth/ADC transport for project-scoped Vertex Interactions API requests. Requests are stored and run in the background. URI delivery writes into a deterministic per-job GCS prefix.
- `server/google-omni-vertex-output-ingestion.mjs`: downloads only objects under the exact configured bucket/prefix/job/request hash and publishes through the existing private, lease-fenced Cloud Asset repository.
- `server/tests/google-omni-vertex-client.test.mjs` and `server/tests/google-omni-vertex-output-ingestion.test.mjs`: request, authorization, path confinement, download, content-type, size and lease tests.

The new transport is not yet composed into `cloud-video-provider-worker-composition.mjs`. No provider is enabled by these modules.

## Configuration prerequisites — do not add until staging is approved

The worker will require:

- `GOOGLE_CLOUD_PROJECT`: Google Cloud project ID.
- `GOOGLE_OMNI_OUTPUT_BUCKET`: dedicated private GCS bucket.
- `GOOGLE_OMNI_OUTPUT_PREFIX`: optional prefix; defaults to `executive-visuals/omni-12`.
- Application Default Credentials for the Vertex AI and Cloud Storage APIs. Prefer workload identity/federation where the hosting platform supports it; otherwise use a protected service-account credential mechanism. Never commit credentials or expose them to browser code.

The Google identity that submits Vertex interactions must have the minimum Vertex AI permissions required to call Interactions API. The Vertex model service identity must be authorized to create objects in the configured output prefix. The worker identity must have read-only access to that prefix. Do not grant project-wide Storage Admin merely to make the integration work.

The bucket must be private. Do not use public object ACLs, public buckets, or browser-accessible GCS URLs. Keep object download and asset publication server-side.

## Request and output contract

- Model: `gemini-omni-1.2-flash`.
- Native generation/edit duration: 3–15 seconds; first/last-frame interpolation and extension have narrower documented limits.
- Output resolutions: 360p, 720p, 1080p and 4K; cost preflight must reject any resolution without a verified rate card.
- URI output requires a `gcs_uri` destination. The worker generates that destination from its own bucket/prefix and the durable job ID + request hash; callers cannot supply an arbitrary GCS path.
- The Vertex interaction ID and output URI must be durably associated with the exact owner, project, job, request hash and current worker lease.
- Downloaded output must pass byte limits, MP4 content-type checks, SHA-256 calculation and private asset publication before the job can complete.

## Pricing and billing gate

Google's November 5, 2026 announcement states $0.07 per second for 720p video and supports generation/editing up to 15 seconds. This is useful for product-level estimates, but the published announcement alone is not a complete provider usage settlement contract. The current Gemini Developer API pricing table still documents the 1.1 token rates separately.

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
- Video generation request/response and GCS URI delivery: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-text
- Gemini Omni 1.2 launch and published 720p price: https://cloud.google.com/blog/products/ai-machine-learning/gemini-omni-1-2-flash-generally-available
- Google Cloud Generative AI pricing: https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
