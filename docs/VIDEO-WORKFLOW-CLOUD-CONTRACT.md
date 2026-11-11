# Governed video workflow contract

This slice establishes the immutable request and private-input boundary for the first hosted Video Studio workflow adapter.

## Supported contract

- Only `video.generate` nodes are accepted.
- The initial cloud adapter identity is explicitly `runway/model-router`.
- Operations are derived from connected media roles: text-to-video, image-to-video, or video-to-video.
- Prompt, duration, aspect ratio, resolution, audio mode, source and reference IDs are normalized through the shared video-generation contract.
- The canonical request is hashed and deeply frozen before quote or approval handling.
- Duplicate asset IDs, conflicting asset roles, unsupported media combinations, unknown adapter identities and unsupported duration/resolution values fail closed.

## Private source resolution

`createRunwaySourceAssetResolver()` resolves each source/reference ID through the authenticated owner/project-scoped asset repository. It verifies project ownership, allowed private bucket and object path, media type, exact stored size and checksum before preparing provider input. Downloads are streamed with a hard byte ceiling and bounded FFprobe inspection. Cross-project assets are rejected before signing or downloading.

## Security and billing boundary

This code is a contract and resolver foundation only. It does **not** authenticate an API caller, quote a provider, create approval, reserve customer credits/provider budget, enqueue a durable job, call a provider, or publish an output. Those steps must be composed by the authenticated cloud workflow API and service-role transaction before remote execution.

No paid provider calls or database migrations are performed by this slice. Cloud execution remains disabled unless the separate server-side feature gates and release acceptance are explicitly configured.

## Verification

Run:

```bash
npm run verify:video-workflow-cloud-contract
```

The command covers normalized request contracts, deterministic request hashes, deep immutability, role conflicts, unsupported operations, private asset authorization, bounded downloads, and FFprobe metadata handling.
