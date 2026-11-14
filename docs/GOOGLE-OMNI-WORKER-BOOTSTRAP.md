# Google Omni cloud-worker bootstrap

Google Omni execution is part of the existing provider-aware cloud-video worker. It is not a separate queue and it does not bypass the cloud video approval, lease, billing, or private-output boundaries.

## Required gates

The worker accepts Google Omni as its only configured video provider when all of the following are explicitly set:

- `CLOUD_VIDEO_WORKER_ENABLED=true`
- `VIDEO_GATEWAY_ENABLED=true`
- `VIDEO_GATEWAY_ALLOW_REMOTE=true`
- `GOOGLE_OMNI_VIDEO_ENABLED=true`
- `GOOGLE_OMNI_VIDEO_ALLOW_REMOTE=true`
- `GEMINI_OMNI_ENABLED=true`
- `GEMINI_OMNI_ALLOW_REMOTE=true`
- `GOOGLE_OMNI_CONNECTION_STATUS=connected`
- `GEMINI_OMNI_PAID_TIER_CONFIRMED=true`
- `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` configured server-side
- `CLOUD_VIDEO_OUTPUT_HOSTS` configured with the exact provider output hosts

The connection status environment value is only a startup gate. It is not treated as proof of a live account connection; every provider operation still invokes the injected live connection verifier.

## Worker host integration

The cloud-worker process accepts policy callbacks from its hosting runtime:

```js
import { startCloudWorkerProcess } from "./server/cloud-worker-process.mjs";

await startCloudWorkerProcess(process.env, {
  providerDependencies: {
    googleOmniAssertConnection,
    googleOmniAssertApprovedSubmission,
    googleOmniAuthorizeInteraction,
    googleOmniPreparePlan,
    googleOmniRetentionExpiresAt,
    googleOmniAuthorizeOutputIngestion
  }
});
```

These functions are mandatory when Google Omni gates are enabled:

- `googleOmniAssertConnection` must verify a live, connected provider account for the operation.
- `googleOmniAssertApprovedSubmission` must confirm the durable budget approval and reservation for the exact job and request hash.
- `googleOmniAuthorizeInteraction` must authorize the exact owner, project, job and interaction before polling or ingestion.
- `googleOmniPreparePlan` must resolve the approved snapshot into a bounded Interactions API plan using owner-scoped private assets.
- Optional retention and output authorization callbacks can add stricter policy.

The worker composition refuses to start if the required callbacks are absent. Do not replace them with permissive stubs or trust `GOOGLE_OMNI_CONNECTION_STATUS` as a substitute for live verification.

## Operational boundary

The existing `start:cloud-worker` command remains suitable for worker families that need no injected application policy. A deployment that enables Google Omni must use a host/bootstrap module that supplies the real callbacks above. This patch makes that dependency injection path available; it does not create a Google account connection, configure provider credentials, or enable paid remote execution.

Keep all Google Omni gates disabled until the host provides real implementations and staging has verified approval, source-asset authorization, output ingestion, actual-cost reconciliation, and recovery.
