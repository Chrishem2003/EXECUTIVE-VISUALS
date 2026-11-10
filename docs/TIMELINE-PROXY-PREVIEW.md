# Timeline proxy and frame-preview batch

## Delivered

- Timeline video clips can queue a private media.proxy job from the clip inspector.
- Proxy output uses a bounded H.264/AAC editing profile: default 960-pixel maximum width, CRF 28, 2 Mbps max rate, AAC 128 kbps, and MP4 fast-start metadata.
- Proxy width is clamped to 320–1920 pixels and CRF to 18–35. User-provided filter text is never accepted.
- Proxy output is a derivative asset linked to the original source asset. Processing provenance records source asset ID, source SHA-256 and proxy profile parameters.
- Once the user checks the completed job, the editor links the proxy asset ID to the selected clip and loads a preview video using the authenticated private-asset file endpoint.
- Timeline users can queue media.thumbnail for a chosen source-frame number. The extracted image is loaded into the clip inspector.
- Authenticated blob retrieval uses the same in-memory bearer token as normal API requests.
- Proxy and frame jobs are restricted to video sources.

## Source and render safety

The timeline's canonical clip.assetId is not changed. The proxy is referenced only by optional clip.metadata.proxyAssetId metadata. Existing local and cloud master renderers continue resolving the canonical source asset, not the proxy. Deleting or replacing the proxy therefore cannot silently change master-render source media.

The proxy remains a normal derived private asset with source lineage and SHA-256 provenance. It is not a quality-approved enhancement and is not presented as an AI upscale.

## Current scope and limitations

- This editor integration currently queues proxy and frame jobs through the local authenticated media worker. The cloud timeline worker is intentionally not broadened in this batch; its queue remains restricted to the existing timeline-render job.
- Source-frame selection is converted to seconds using the source frame rate available in the saved FFprobe metadata. For variable-frame-rate media, this is an approximate frame-to-time mapping, not a decoder-verified exact frame index.
- The browser preview loads the proxy as an authenticated Blob URL. It is a clip-level review player, not yet a synchronized multi-track timeline transport or before/after comparison monitor.
- The proxy is a preview derivative only. Final master output continues to use the original source asset.
- Durable timeline revision browsing and cross-device restoration remain a separate milestone.

## Validation

- server/tests/timeline-proxy-preview.test.mjs verifies bounded proxy FFmpeg arguments and source lineage metadata.
- npm run verify:timeline runs the timeline structure check plus proxy profile tests.
- Full TypeScript build and GitHub Actions remain the integration gate.
