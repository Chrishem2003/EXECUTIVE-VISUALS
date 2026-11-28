# Competitive creative-production blueprint — Batch 152

**Date:** 28 November 2026  
**Base:** Batch 151 head `64dc5033431819b7e82bcde6e4e93ab10130a724`  
**Status:** Product/engineering blueprint; this document does not claim that the proposed capabilities are implemented or that the platform is launch-ready.

## Product thesis

Executive Visuals should be the operating system for a small creative team: one place to research, brief, plan, generate, edit, localize, review, deliver and learn from digital campaigns. The differentiator is not the number of model buttons. It is the reliable, auditable path from a business objective to a complete, on-brand, multi-format campaign whose cost, rights, provenance and performance can be understood.

The platform must remain provider-neutral. Integrate providers through explicit adapters and capability contracts; do not copy proprietary code, protected UI assets, trademarks, model weights or private workflows. Reimplement useful public product behaviours with original design and code.

## Reverse-engineering findings

| Reference product | Observable strength worth learning from | Executive Visuals response |
|---|---|---|
| Runway Agent / Workflows | Agent plans and creates multi-shot media, edits images/video, builds timelines, and runs repeatable skills | Make Creative Director a production agent that creates inspectable plans and invokes only approved, costed workflow nodes |
| Runway Brand Kits | Reusable assets and written rules guide generations across sessions and shared projects | Upgrade existing brand kits into versioned, enforceable brand constraints with per-output compliance evidence |
| Descript | Transcript-first editing, AI co-editor, filler/retake removal, recording and audio cleanup | Add transcript-to-timeline editing with reversible edit decisions and exact source timecode mapping |
| Adobe Firefly | Image, video, audio and vector creation; precision editing; Content Credentials and commercial-safety positioning | Make rights evidence, provenance and commercial-use policy visible before generation and at delivery |
| Higgsfield | Cinematography controls, camera moves, character identity and multi-shot visual consistency | Offer a model-neutral shot grammar, camera-move vocabulary and continuity checks across scenes |
| Canva | Accessible, template-led design and brand consistency for everyday marketing assets | Provide fast campaign templates and social-format adaptation without hiding advanced controls |

Research references:
- Runway Agent: https://help.runwayml.com/hc/en-us/articles/51601639579667-Creating-with-Runway-Agent
- Runway Agent Skills: https://help.runwayml.com/hc/en-us/articles/53907039424915-Using-Agent-Skills
- Runway Brand Kits: https://help.runwayml.com/hc/en-us/articles/53908585609235-Using-Brand-Kits-with-Agent
- Descript features: https://www.descript.com/features
- Adobe Firefly: https://www.adobe.com/products/firefly.html
- Higgsfield model guidance: https://higgsfield.ai/creator-hub/help-center/ai-models/which-ai-model-should-i-use

## What the repository already contains

The inspected Batch 151 branch already includes substantial foundations: Creative Director and storyboard compilation, story/series planning, a multi-track timeline, FFmpeg media processing, provider capability discovery, a brand-kit document model, asset provenance/C2PA work, cost estimation, generation approval, customer credit gates, margin preflight, durable queue/worker code and Paddle/Pesapal billing work.

Do not create parallel systems for these capabilities. Extend the existing contracts and preserve their audit, authorization and fail-closed behaviour.

## New product advantage: the Campaign Intelligence Graph

Build this as a connected layer over existing project, brand-kit, storyboard, asset, timeline, workflow, billing and provenance records.

### 1. Brand and character continuity graph
- Bind a campaign to a versioned brand kit, character sheets, product references, approved logos, typography, palette, voice and prohibited terms.
- Track each reference's origin, rights/consent status, scope, expiry and allowed use.
- Before a generation, produce a constraint report: satisfied, unknown, conflicting or blocked.
- After generation, record which constraints were checked and which need human visual review.
- Detect likely continuity drift across shots (identity, wardrobe, product geometry, lighting, palette and camera grammar); never claim visual correctness without an actual evaluator or human review.

### 2. Campaign-to-every-format compiler
- One approved brief and storyboard become a master campaign package.
- Derive platform-specific cut plans (16:9, 9:16, 1:1, 4:5), duration, safe areas, captions, CTA placement and audio requirements.
- Keep a shared narrative and brand source while allowing channel-specific hooks and edits.
- Use deterministic timeline transforms where possible; AI may suggest changes but must produce a diff and require approval before modifying the master.
- Generate a delivery manifest with filenames, dimensions, codecs, captions, rights evidence and checksums.

### 3. Natural-language editing with reversible transactions
- Accept commands such as “remove the pause after the second answer”, “make a 15-second vertical cut”, or “replace the end card with the approved product offer”.
- Resolve commands to exact assets, clips and time ranges; ask for clarification when the target is ambiguous.
- Present a proposed edit diff, estimated render cost and affected outputs.
- Apply as an undoable timeline transaction; preserve original media and prior versions.
- Never let an LLM directly mutate timeline JSON or execute shell commands.

### 4. Creative quality and delivery gate
- Validate media integrity, dimensions, duration, frame rate, audio loudness/peaks, caption bounds, missing assets, black frames, unsupported codecs, aspect ratio and export completion.
- Attach each result to source assets and processing lineage.
- Separate machine checks from human approval and rights review.
- Block delivery when a mandatory check fails; allow an authorized reviewer to record a reasoned exception.

### 5. Profit-aware production planner
- Quote provider, model, resolution, duration, retries, storage, egress and render costs before work is queued.
- Show customer price, estimated cost, risk buffer and projected gross margin.
- Reserve credits atomically before dispatch; settle against measured usage; release reservations on terminal failure.
- Enforce per-user concurrency, daily spend, project budgets, provider circuit breakers and owner kill switches.
- Reconcile provider invoices/usage with internal jobs. Never expose a paid model as free or silently retry expensive work.

### 6. Campaign learning loop
- Store channel, creative hypothesis, hook, offer, variant, publish date and campaign outcome supplied by the customer.
- Import performance only through authorized connectors and explicit permissions.
- Compare variants with sample-size and attribution caveats; recommend the next experiment, not unsupported causal claims.
- Feed learnings into future briefs as evidence with source, date and confidence.

## Delivery order — value before breadth

### P0 — Make one paid journey genuinely work
1. Isolated staging identity and PostgreSQL application persistence.
2. Private asset upload, read, download, deletion and tenant-isolation round trip.
3. Durable worker heartbeat, restart recovery, cancellation and atomic output publication.
4. Real provider sandbox acceptance and signed webhook replay protection.
5. Credit quote → reservation → dispatch → measured settlement → refund/release path.
6. Backup restore rehearsal, real alert delivery and owner operational controls.
7. Browser E2E: register → create project → upload → brief/storyboard → approved generation → edit → export → pay/renew/cancel.

### P1 — Make the studio materially better
1. Campaign Intelligence Graph and versioned brand/character constraints.
2. Transcript-first editing and reversible natural-language timeline operations.
3. Campaign-to-every-format compiler and delivery manifests.
4. Visual continuity review with clear machine-vs-human confidence labels.
5. Agency workspaces, reviewer approvals and client-safe share links.

### P2 — Expand the creative surface
1. Vector and raster graphics workspace with reusable templates and brand-safe exports.
2. Motion-graphics and data-visualization builder.
3. Voice, dubbing, translation and lip-sync workflows with consent and rights controls.
4. Product photography, listing kits and commerce campaign packages.
5. Authorized campaign analytics and experiment recommendations.

## Engineering acceptance rules

- Every user-visible action must call a real API and produce a durable result or a clear disabled/unavailable state.
- Every remote generation must have a quote, approval, idempotency key, credit reservation, provider task ID, measured settlement and audit trail.
- Every media object must have an owner, project scope, private-storage policy, checksum, provenance and retention/deletion lifecycle.
- Every worker must be restart-safe, lease-fenced, bounded in retries and observable.
- Every external integration must be optional, least-privilege, revocable and tested against sandbox or disposable fixtures.
- Every feature must have unit tests, API authorization tests, persistence tests where relevant, and a browser journey before it is called complete.
- No paid infrastructure, production migrations, production deployment, secret exposure or destructive resource changes without the existing owner-approval process.

## Current release reality

As of this blueprint, the latest identified PR is #911. Its six reported PR workflow groups passed on the exact head, but its runtime acceptance remains opt-in and depends on protected staging configuration. The Batch 148 preflight explicitly reported 18 missing staging settings; it also documented that the current Render staging service still tracks `main` with auto-deploy enabled and that the app runtime still reports SQLite. Those are operational blockers, not UI polish tasks.

**Do not merge the stacked draft PR chain or deploy to production merely to make a green badge.** Verify the exact head, dependencies, database target, staging identity, storage and full user journey first.

## First commercial offer

Start with a narrow, demonstrably useful offer: **AI Campaign Studio for small businesses and agencies** — produce a product/brand brief, a storyboard, a short video ad, matching social graphics, captions and platform-ready exports in one reviewed project. Sell it as a production workflow, not as unlimited access to expensive model calls. Keep generation usage metered and separately costed; charge for collaboration, campaign packages and high-value exports only when those features are actually enabled and supported.
