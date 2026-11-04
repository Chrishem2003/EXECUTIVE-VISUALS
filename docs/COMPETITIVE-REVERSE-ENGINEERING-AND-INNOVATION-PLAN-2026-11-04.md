# Competitive Reverse-Engineering & Innovation Plan

**Research date:** 4 November 2026  
**Target:** EXECUTIVE-VISUALS / CHRISHEM EXCLUSIVE VISUALS  
**Working branch:** `feat/executive-visuals-unified-platform`  
**Status:** Research synthesis and implementation direction; proposed features remain unimplemented until code, tests and evidence are added.

## Executive direction

Build one provider-neutral creative production and creator-business operating system. Do not build a collection of shallow competitor clones. Connect creative intent, rights, assets, generation, editing, finishing, review, publishing, analytics and monetization through durable project records and versioned workflows.

The repository already has a substantial foundation: Creative DNA, typed workflow graphs, multi-track timeline, local FFmpeg rendering, captions, persistent jobs/leases/retries, project-scoped assets and provenance, review/approval records, capability catalogue and partial cloud adapters. The README explicitly marks production generation, complete browser timeline preview, transitions/effects/animated overlays, multi-host storage, live collaboration and publishing as unfinished. The release-gate document says public release is not approved.

## Competitive capability map

| Platform / category | Publicly documented capability pattern | Independent product direction |
|---|---|---|
| Adobe Premiere | Transcript-driven editing; paper edits; generative video and sound effects placed directly into an editable timeline; generative clip extension | Transcript-to-timeline editing and timeline-native generation; preserve originals and model-specific constraints |
| DaVinci Resolve | Editing, Fusion VFX/compositing/tracking, Fairlight audio post, color grading, mastering and delivery | Separate but integrated editing, compositing, color and audio finishing subsystems |
| Runway developer platform | Multi-provider image/video/audio catalogue, model/workflow APIs, same-prompt evaluation, routing by cost/latency/quality, spend visibility | Provider-neutral adapter registry, benchmark harness and policy-constrained model router |
| Kling / Veo / Seedance / Wan / MiniMax / Luma | Model-specific text/image/video reference modes, native audio, keyframes, multishot, video editing and varied duration/resolution constraints | Runtime capability discovery; do not assume all models support the same controls |
| HeyGen / Synthesia | Avatar-led video production, translation/localization, templates and video analytics | Consent-based presenter studio, reusable presenter profiles and localization tracks |
| ElevenLabs | Speech synthesis, transcription, word timestamps, speaker diarization, dubbing and multilingual voice preservation | Separate transcript, speaker, voice, locale and timing objects; retain original soundtrack and remaster from source |
| Descript | Transcript-centric editing and audio/video production | Search, cut and rearrange source footage from a synchronized transcript |
| OpusClip / Captions / Riverside | Highlight discovery, short-form repurposing, captions, reframing and creator recording workflows | Source-to-campaign repurposing with human approval and independently edited platform variants |
| Frame.io / Vimeo | Timecoded comments, review, versions, uploads, privacy, transcripts, alternate audio and analytics | Client review portal, signed expiring links, version comparison and delivery integrations |
| Artlist / stock-media licensing | Music, SFX, footage and templates licensed for defined projects, channels, territories and subscription terms | Rights-aware asset catalogue and per-project license evidence; never treat a subscription as blanket ownership |
| YouTube / TikTok APIs | Authorized publishing, metadata, upload processing/status, analytics and platform-specific permissions/audits | Human-approved distribution queue with platform policy and account eligibility checks |

## Verified repository position

### Implemented or evidenced in repository README / implementation records

- Creative brief, script, storyboard, shot planning and Creative DNA compiler.
- Typed workflow graph with validation and execution planning.
- Multi-track timeline with frame-based trims/splits, timeline variants and structural comparisons.
- Local FFmpeg/FFprobe media processing and master rendering; synchronized audio, still overlays and burned captions.
- Persistent jobs, renewable leases, stale-worker recovery, bounded retries and cancellation polling.
- Project-scoped asset ownership, checksums, original/derivative lineage and audit records.
- Roles, review comments, approvals, creative intent traceability and append-only decision history.
- Capability atlas (110 definitions across 23 domains).
- Some isolated cloud database, queue, asset and timeline adapters with explicit feature flags; not yet the fully active multi-tenant hosted runtime.

### Explicitly incomplete / not yet release-ready

- Normal end-user hosted authentication and recovery UX.
- Active private cloud object storage integration across the primary asset API and browser library.
- Production database/queue/worker architecture for multi-instance use.
- Complete browser timeline playback/preview, waveform and frame-accurate interactive editing.
- Transitions, keyframes, effects, motion graphics and animated/video overlays with render parity.
- Verified live image/video/speech generation and production-grade provider adapters.
- Full speech transcription/dubbing/localization UI and track management.
- Live collaboration/presence, proxy review and share-link revocation.
- Social publishing and analytics integrations.
- Creator revenue, client commerce, licensing and subscription workflows.
- Backup/restore, monitoring, capacity controls and hosted multi-role end-to-end acceptance.

A catalogue entry or design document is not evidence of an operational feature. Preserve the repository's readiness states: specified, implemented, contract-tested, connected, live-verified.

## Priority implementation roadmap

### P0 — Safe hosted foundation (must precede public beta)

1. Complete normal Supabase Auth sign-in/sign-up, email verification/recovery, session refresh/logout and abuse protection. Do not ask end users to paste access tokens.
2. Complete dedicated isolated backend provisioning and review. Never reuse the NEMA or shared platform Supabase projects.
3. Integrate private object storage into the active asset API and browser library: resumable uploads, signed downloads, checksums, quotas, retention and cleanup.
4. Choose and prove durable database/queue/worker architecture. SQLite plus one persistent disk remains single-instance only.
5. Implement backup/restore rehearsal, structured redacted observability, resource limits and rollback procedure.
6. Retain existing account lockout/rate-limit work and verify it in hosted staging.

**Exit:** separate owner/editor/reviewer/viewer accounts pass hosted isolation, session, upload, job, cancellation, review and render tests; restore is proven; no production resources are changed.

### P1 — Professional editing loop

1. Browser timeline preview with proxy-first playback, waveform, frame-accurate seek, snapping, track mute/solo, undo/redo and autosave conflict handling.
2. Transcript editor with word/segment timestamps and edit-to-timeline synchronization.
3. Transitions, keyframes, motion transforms, title/lower-third templates, animated overlays and audio ducking; deterministic render parity tests.
4. Color correction and audio finishing controls; export profiles for social, web, broadcast and archive.
5. Render checkpoints/resume, progress estimates, output verification and retry-safe finalization.
6. Review annotations, version A/B, reviewer assignments, expiring/revocable links and approval checkpoints.

**Exit:** an editor can ingest media, build/preview a sequence, edit by transcript, review with collaborators, resolve comments and export repeatable masters and variants.

### P2 — Real AI generation and intelligence

1. Versioned provider adapters for image, text/image-to-video, video-to-video/edit, keyframe/reference control, native audio, speech, transcription, translation and dubbing.
2. Runtime model capability discovery: supported modes, references, durations, frame rates, resolutions, audio, regions, API version, retention, price unit, concurrency, rate limits and retirement status.
3. Evaluation harness: fixed prompt/media datasets, blind human ratings, prompt adherence, identity/continuity, motion, artifact rates, latency, cost and failure classification.
4. Policy-constrained router: user-selected provider restrictions, rights, consent, data classification, region, quality, latency and budget eligibility before scoring.
5. Project/job budget preflight, hard spend ceilings, usage ledger, idempotent provider submissions, signed callbacks/polling and durable output-copy.
6. Character/product/world continuity review and human sign-off.

**Exit:** each live adapter is contract-tested and opt-in smoke-tested; no paid calls in CI; cost limits and consent/rights constraints are enforced.

### P3 — Distribution, growth and monetization

1. Platform export presets and a publish queue with caption/title/thumbnail/metadata variants.
2. OAuth-based YouTube integration first: upload, metadata, status, and permitted analytics; respect quota and OAuth scopes.
3. TikTok integration only after Content Posting API app approval, required scopes and audit; unaudited clients are restricted to private viewing. Always require explicit user confirmation and show platform privacy settings.
4. Add other platform integrations only after official API scope, publishing permissions, review/audit and regional availability are verified.
5. Campaign analytics: retention, watch time, completion, click-through, engagement and conversion; tie metrics to source project and exact published variant.
6. Client business workspace: lead/brief intake, estimate, quote, milestones, revisions, approval, invoice/payment-provider integration and delivery.
7. Digital products/templates/presets, paid memberships, commercial licensing and affiliate campaigns through compliant external providers.
8. Region-aware monetization eligibility and payout checklist. YouTube's expanded YPP documentation lists Uganda among eligible countries/regions; early fan-funding eligibility and full ad-revenue eligibility have different thresholds and feature requirements. Recheck policy and feature availability for each account before making a promise.

**Exit:** creator can prepare and approve a publish package, see publishing status, measure variant outcomes and track legitimate client/product revenue without the app promising earnings or bypassing platform rules.

## Original differentiation opportunities

1. **Creative Intent Graph:** a durable link from audience promise and proof requirements to scenes, shots, assets, edit decisions, approvals, variants and campaign outcomes. Extend existing Creative DNA and decision ledger.
2. **Timeline-Native AI Repair:** identify a missing shot, weak transition, unwanted object or audio gap; propose a bounded edit plan; preview alternatives; insert only after approval.
3. **Creative Yield Engine:** transform one approved master into genuinely re-edited platform variants (new hook, pacing, framing, captions, CTA), not merely aspect-ratio crops.
4. **Continuity and Product Truth Engine:** compare faces, wardrobe, props, brand/product geometry, location, light and screen direction against approved references; flag uncertainty for human review.
5. **Proof-First Video QA:** validate claims against cited evidence, check that opening promises are fulfilled, and distinguish factual, subjective and unsupported statements.
6. **Regional Creator Revenue Navigator:** eligibility and payout readiness by country/platform, with verified sources, current thresholds, account-specific unknowns and alternate revenue channels. No earnings guarantees.
7. **Rights & Consent Passport:** asset-level license scope, territory, term, client use, music clearance, model release, voice/likeness consent, attribution and revocation state.
8. **Low-Bandwidth Production Mode:** proxy-first review, resumable chunked uploads, background sync, adaptive previews and local FFmpeg worker fallback.
9. **Model Cost/Quality Observatory:** compare candidate models on a fixed evaluation set; show quality, cost, latency, failure and provenance before selection.
10. **Creator-to-Client Marketplace:** sell finished editing services, campaign packages, reusable templates and licensed deliverables, with escrow/payment integration only through a verified compliant provider.

## Critical design rules

- Never couple application logic directly to one AI vendor. Provider contracts and capability discovery must be versioned.
- Never claim neural upscaling when only FFmpeg scaling ran.
- Never silently submit paid generation; require price disclosure, user budget and explicit approval.
- Keep original media immutable; every derivative has source lineage and checksums.
- Do not infer rights from an upload or a stock subscription. Store license scope and proof.
- Never clone a person's face or voice without appropriate consent and rights.
- Keep all publishing actions user-authorized; obey OAuth scopes, app audits, rate limits, platform privacy settings and regional restrictions.
- Monetization tools must distinguish creator revenue from platform eligibility; do not promise earnings.
- Do not launch public services until P0 release gates and owner approval are complete.
- Preserve the feature branch and production boundary; no merges, deployments, paid infrastructure or schema application without explicit approval.

## First-party research sources

- Runway developer model platform and routing: https://dev.runwayml.com/ and https://docs.dev.runwayml.com/guides/models/
- Adobe Premiere generative media: https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-media-tool-overview.html
- Adobe Premiere generative extend: https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-extend-overview.html
- Adobe transcript editing: https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/overview-of-text-based-editing.html
- DaVinci Resolve: https://www.blackmagicdesign.com/products/davinciresolve
- ElevenLabs dubbing and speech docs: https://elevenlabs.io/docs/overview/capabilities/dubbing and https://elevenlabs.io/docs/overview/intro
- YouTube upload API: https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- YouTube Partner Program regional eligibility: https://support.google.com/youtube/answer/13429240 and https://support.google.com/youtube/answer/94522
- TikTok Content Posting API: https://developers.tiktok.com/docs/en/content-posting-api-get-started and https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- Vimeo API capabilities and upload: https://developer.vimeo.com/api/reference/videos and https://developer.vimeo.com/api/upload/videos
- Artlist licensing: https://help.artlist.io/hc/en-us/articles/29490991524253-Understanding-Artlist-s-license

**Evidence caveat:** product features, pricing, API permissions, eligibility and availability change frequently. The links above are research starting points; each integration must revalidate current official documentation and terms at implementation time.
