# Product North Star & Master Build Plan (2026)

**Status:** canonical product strategy and engineering backlog proposal. This document consolidates the original Creative Intelligence Atlas, the competitive reverse-engineering discoveries from November 2026, the current repository baseline, and the release discipline. Ideas are not considered implemented until the acceptance evidence in this document exists.

**Repository baseline inspected:** `main` at `80b868463284f97813a5ce32cd29ea8c3a236607`.

## 1. Product North Star

Build an original, provider-neutral **Creative Production Operating System** for solo creators, production teams, agencies and marketing departments.

The platform connects creative intent, research, assets, workflows, editing, rights, review, delivery, publishing and business outcomes in one coherent project model. It must solve complete user problems, not merely expose a catalogue of models or attractive buttons.

### Product promise

A user describes an outcome and constraints. The platform helps plan the work, assembles a verifiable workflow, estimates cost and risk, executes approved operations, preserves every source and decision, validates the deliverables, routes review, and produces a reusable handoff package.

### Differentiation

1. **Creative Intent Graph:** preserves audience promise, evidence, narrative, visual grammar, sound identity, shots, assets, timeline, approvals and outputs as linked objects.
2. **Proof-to-Publish Trust Engine:** connects claims, evidence, source assets, licensing, likeness/voice consent, transformations and approval to each deliverable.
3. **Adaptive Production Engine:** selects only verified-capable operations based on quality, cost, latency, privacy, availability and user constraints.
4. **One-to-Many Production Compiler:** produces channel, audience and language variants from an approved master while retaining lineage and review status.
5. **Creative Business Intelligence:** connects scope, time, spend, revisions, delivery and campaign outcomes to profitability and future experiments.

These are original synthesis and design proposals informed by public product behavior. Do not copy competitor branding, proprietary code, private interfaces or undocumented behavior.

## 2. Customer problems and product journeys

### Solo creator
Brief → research → creative direction → script/storyboard → source/generate media → edit → captions/audio → quality check → export → publish-ready package.

### Production team
Ingest → organize → proxy → assign → edit → review by frame/timecode → revision branches → approval → finishing → delivery and archive.

### Agency
Client intake → scope/proposal → brand kit → campaign plan → production budget → team allocation → client review → revision control → invoice/delivery → profitability report.

### Marketing department
Product facts and approved claims → audience/campaign hypothesis → multi-channel variants → localization/accessibility → approvals → scheduled publishing → performance measurement → next experiment.

### Education, public-interest and regulated communications
Evidence-first brief → source validation → consent/rights → plain-language creative → accessibility/localization → review and disclosure → auditable distribution package.

## 3. Competitive capability discoveries and original adaptations

The following matrix records public workflow patterns and the original platform response. The linked sources are public research references, not implementation dependencies.

| Market pattern / reference | User problem solved | Original adaptation |
|---|---|---|
| Adobe creative agent orchestrates multi-step specialist tasks | Repetitive setup and batch operations consume creative time | Intent-aware production agent that proposes inspectable operations, previews impact and asks approval before destructive/paid/publishing actions |
| Frame.io V4 resource hierarchy, metadata, relationship-based access, shares and version stacks | Media review and organization become fragmented | Native asset graph with workspace/project/folder/asset/version/share entities, scoped permissions, typed metadata and revision lineage |
| Runway typed node workflows | Repeatable media workflows require manual handoffs | Strongly typed graph with compatibility checks, versioned templates, deterministic utility nodes, cost gates and execution traces |
| Professional NLE timeline and finishing | Separate editing, audio, color and delivery tools create friction | Timeline-first editing with interchange, non-destructive branches, preview/export parity and validated finishing |
| Canva brand controls and data-bound templates | Teams create inconsistent variants manually | Versioned brand policy + structured template compiler + campaign data binding + preflight |
| Figma branching and version control patterns | Experimentation can destabilize approved work | Isolated creative branches, review, diff, merge and rollback for timeline/workflow/brand artifacts |
| Voice and dubbing platforms | Localization loses timing, tone and speaker continuity | Speaker-aware language tracks with pronunciation glossary, timing parity, human review and source revision lineage |
| C2PA Content Credentials | Media origin and transformation history are hard to communicate | Provenance manifest that distinguishes recorded facts, declared actions, unverified metadata and missing credentials |
| OpenTimelineIO | Editorial projects are difficult to exchange across tools | OTIO import/export adapter for editorial structure; preserve source media externally and clearly report unsupported constructs |
| Agency operations suites | Creative delivery disconnects from scope, time and profitability | Client/project/estimate/time/budget/revision/invoice/delivery ledger integrated with production |
| WCAG 2.2 | Accessibility is treated as a late checklist | Accessibility preflight integrated into storyboard, captions, player, contrast, keyboard and export requirements |
| Social platform publishing APIs | Publishing and analytics differ by destination | Destination adapters with explicit capabilities, consent, quotas, idempotency, receipts and data freshness labels |

### Additional original features to evaluate

#### Creative intelligence
- Distinctiveness stress test; audience contract checker; emotional pacing map; narrative tension curve; hook mechanism lab.
- Visual grammar compiler; camera motivation checker; shot necessity analysis; visual rhythm map; motif continuity graph.
- Character state ledger; product truth lock; wardrobe/prop transitions; location topology; approved-reference confidence labels.
- Claim-to-shot ledger; evidence confidence; uncertainty labels; misleading-edit review; creative decision memory.
- Change-impact preview that identifies stale scenes, shots, voice tracks, captions, dubs, approvals and exports after an upstream change.

#### Professional production
- Ingest checksums, resumable upload, duplicate detection, proxy/transcode profiles and relinking.
- Semantic media search across authorized assets: transcript, speaker, scene, object, action, timecode and visual similarity.
- Multi-track/multicam timeline, frame-accurate trims, keyframes, transitions, compositing, color management, scopes, audio buses, automation, loudness and mastering.
- Non-destructive edit branches, A/B comparison, synchronized review and explainable edit suggestions.
- OTIO interchange with explicit fidelity reports; no claim that OTIO embeds media or supports every proprietary effect.
- Render farm/worker scheduling with quotas, checkpoints, deterministic job inputs and output verification.

#### Collaboration and operations
- Frame/timecode comments, visual annotations, threads, assignments, reviewer inbox, due dates, client shares, internal/client note separation.
- Review disagreement resolver that surfaces conflicting directions and asks the designated owner; never silently reconciles conflicting feedback.
- Client portal, project brief, scope baseline, change orders, estimate, time tracking, budget envelopes, invoice records, delivery receipts and profitability.
- Production pulse for blockers, stale approvals, expiring rights, storage/compute use and schedule risk.
- One-click handoff package with brief, creative DNA, shot plan, media, edit interchange, captions, rights, approvals, manifest and checksums.

#### AI and model intelligence
- Capability registry based on verified input/output contracts, model versions, quotas, dimensions, duration, supported operations and known limitations.
- Blind model jury; rubric-based quality review; prompt-delta ledger; model drift sentinel; deprecation impact and fallback rehearsal.
- Quality-per-cost frontier using measured results rather than marketing claims.
- Local-first routing when verified quality meets privacy and task constraints.
- Provider task lifecycle adapters with durable polling/webhooks, bounded exponential backoff, cancellation, idempotency and reconciliation.

#### Trust, accessibility and delivery
- Asset license, territory, channel, expiry, source and consent scope.
- C2PA validation and preservation where supported; do not imply C2PA proves ownership or factual truth.
- AI disclosure, source/ingredient lineage, action log, hashes and export verification.
- Captions, speaker labels, sound cues, audio description planning, contrast checks, color-vision preview, keyboard navigation, reduced motion and low-bandwidth export.
- Channel safe areas, duration/codec/resolution/bitrate presets, subtitle and thumbnail checks.
- Publishing destinations with explicit OAuth scopes, least privilege, user confirmation, idempotent submission and platform-specific receipt state.
- Campaign hypothesis and performance learning ledger; avoid claiming causality from observational engagement data.

## 4. Canonical domain model

The product should converge on a shared domain language. Reuse existing records where they already serve the same purpose; do not create parallel versions of projects, jobs, assets or workflows.

- **Organization / Workspace / Membership / Role / Policy**
- **Client / Brand / BrandVersion / BrandRule / TemplateVersion**
- **Project / Brief / CreativeIntent / Evidence / Claim / CreativeDecision**
- **Story / Scene / Shot / Character / Product / Location / Reference**
- **Asset / AssetVersion / Derivative / Proxy / MediaMetadata / RightsGrant / Consent**
- **Workflow / WorkflowVersion / Node / Edge / Run / RunEvent / Checkpoint**
- **Timeline / Track / Clip / Transition / Keyframe / Marker / EditBranch**
- **Review / Comment / Annotation / RevisionRequest / Approval**
- **Render / Deliverable / ExportProfile / HandoffPackage / ProvenanceManifest**
- **Provider / Model / Capability / CredentialReference / UsageReservation / UsageSettlement**
- **ClientEngagement / Scope / Estimate / TimeEntry / Budget / Invoice / DeliveryReceipt**
- **Campaign / Variant / Channel / PublishJob / AnalyticsSnapshot / Experiment**

### Relationship rules
- Every derived asset points to its source asset/version and transformation run.
- Every timeline references immutable asset versions and time ranges.
- Every approval references an exact revision hash, never a moving "latest" pointer.
- Every paid job has an idempotency key, reservation/settlement state and provider receipt where available.
- Every external share has explicit audience, expiry and revocation behavior.
- Every creative claim has an evidence status and responsible reviewer when applicable.
- Every publishing action has an explicit destination, approved payload, actor and receipt.
- Workspace/tenant isolation is enforced server-side for every query and mutation.

## 5. Architecture principles

1. **One source of truth:** reuse existing project, asset, job, capability and workflow systems. Document authoritative ownership for each record.
2. **Capability contracts:** provider adapters declare supported operations, input schema, limits, output schema, auth scopes, cost model confidence and cancellation behavior.
3. **Durable asynchronous work:** outbox/inbox patterns, idempotency, lease fencing, checkpointing, bounded retries, dead-letter/reconciliation paths and observable events.
4. **Immutable media lineage:** content hashes, immutable source versions, derivative relationships and atomic publication.
5. **Non-destructive creative changes:** branch/preview/approve/merge with reversible operations and conflict detection.
6. **Human approval gates:** paid execution, external sharing, publication, deletion, rights decisions and high-impact edits require explicit authorization.
7. **Least privilege and tenant isolation:** authorization at service boundary; private object storage; short-lived signed access; secrets never in browser bundles or logs.
8. **Cost transparency:** estimate before submit, reserve before billable execution, settle against verified provider result, release unused reservation and reconcile ambiguous outcomes.
9. **Provider-neutral core:** business/domain contracts do not depend on one vendor; provider-specific behavior stays in adapters.
10. **Graceful degradation:** local utilities and non-paid workflows remain usable when external providers are unavailable.
11. **Accessibility and responsiveness:** WCAG 2.2 AA as the target for application surfaces; provide keyboard and non-color cues.
12. **No fake functionality:** distinguish idea, specified, implemented, locally tested, adapter verified, staging accepted and production enabled.

## 6. Interface/product design principles: original, not vibe-coded

- Use a distinctive visual system, editorial typography, deliberate density, strong hierarchy, restrained color and purposeful motion.
- Build dedicated workspaces: Command Centre, Director, Story/Shot Map, Workflow Lab, Production Studio, Asset Intelligence, Review Room, Campaign Factory, Client Operations and Runtime Console.
- Keep Focus / Studio / Technical levels: decision-first for newcomers, detailed creative controls for professionals, diagnostics/provenance for operators.
- Keep one project context across canvas, timeline, asset browser, review and business operations.
- Show decision cards with proposal, rationale, expected benefit, uncertainty, risk, cost/latency when known and approval requirements.
- Make save state, autosave conflicts, revision history, undo, cancel and recovery visible.
- Use real empty/loading/error/partial/blocked/success states; no decorative progress bars or placeholder buttons.
- Use accessible keyboard navigation, focus states, labels, contrast and responsive behavior.
- Avoid generic gradient dashboard patterns. Visual polish must express the actual work model.

## 7. Master build sequence and release gates

### P0 — Trustworthy platform foundation (must precede broad feature expansion)
- Reconcile and land the existing durable publication chain in dependency order: lease fencing → worker lifecycle observability → immutable publication attempts → orphan recovery → atomic finalization → pending cleanup.
- Prove stale worker cannot publish after lease loss; prove duplicate requests cannot double-charge or duplicate finalization.
- Verify cloud storage is private, durable, checksum-verified and recoverable; document backup/restore and retention.
- Verify tenant/project authorization on every API route, asset operation, workflow, share and review mutation.
- Finish auth/session refresh and production identity flow; test CSRF, rate limits, secrets and audit redaction.
- Finish job cancellation, provider polling/webhooks, reconciliation and operator-visible failure recovery.
- Add production-like integration tests, concurrency/fault injection and restore drills.
- **Exit:** all P0 tests pass; security review completed; staging end-to-end journeys pass; no unresolved critical/high severity issue; no unapproved production changes.

### P1 — One complete professional production journey
- Connect Creative DNA/Intent to project persistence, shots, timeline, evidence and creative decisions.
- Complete asset ingest, media probe, checksums, proxies, relinking and source/derivative lineage.
- Complete timeline preview and export parity; validate audio sync, transitions, effects, captions, frame rate, color and media integrity.
- Add OTIO import/export experiment with compatibility matrix and round-trip tests.
- Integrate only verified provider operations through durable workers, with preflight and cost/rights/consent approval.
- Add quality gate: missing media, black frames, clipping, loudness, caption overlap, safe areas, resolution, codec and duration.
- **Exit:** user can take one project from brief to reviewed, verified master export with no manual database edits and with full provenance.

### P2 — Creative intelligence and trust
- Creative Intent Graph and change-impact analysis, including asset SHA-256/size fingerprints in revision comparison and downstream review flags.
- Claim-to-shot/evidence ledger, source citations and uncertainty.
  - Source integrity gate: re-hash the managed file and verify byte size against ingest metadata before evidence submission and before every reviewer decision; fail closed on missing or modified bytes.
  - Reviewer decisions require a written rationale and append-only actor/event history; the UI exposes the source SHA-256 fingerprint and source reference. This verifies byte continuity, not claim truth or legal rights.
- Project Canon for character/product/location/wardrobe/prop continuity.
- Semantic asset indexing with consent and access filters.
- C2PA inspection/preservation and export manifest where supported.
- Rights expiry, consent scope and brand truth validation.
- **Exit:** user can inspect why an output exists, what sources/rights it relies on, what changed and which downstream outputs need refresh.

### P3 — Collaboration and multi-output studio
- Review room: timecode/frame comments, annotations, threaded feedback, assignments, version compare and exact-revision approvals.
- Client portal and share policy with expiry/revocation.
- Brand governance with multiple brand versions, reusable template compiler and campaign variant lineage.
- Localization pipeline with glossary, pronunciation, speaker/timing parity and review.
- Accessibility checks and low-bandwidth delivery.
- **Exit:** an agency team can produce, review, approve and deliver a campaign with multiple variants and languages.

### P4 — Commercial operations
- Client intake, engagement scope, estimate, time entries, budget, change orders, invoices and delivery receipts.
- Cost reservations/settlements for AI, storage and render compute.
- Project margin and revision-scope alerts.
- Subscription/entitlement enforcement only after billing lifecycle and support processes are reliable.
- **Exit:** complete auditable client project from intake to payment reconciliation and profitability report.

### P5 — Publishing and performance learning
- Destination adapter registry and OAuth scopes.
- User-confirmed publish jobs, idempotency, platform receipts and failed-publish recovery.
- Analytics snapshots with freshness/source labels.
- Creative hypothesis board, experiment variants and post-campaign learning.
- **Exit:** an approved deliverable can be published to a supported destination and measured without misrepresenting metrics or bypassing platform policies.

### P6 — Advanced intelligence and research
- Blind model jury and quality-per-cost routing.
- Model drift/deprecation monitoring and fallback rehearsal.
- Local inference scheduling and low-resource device workflows.
- Advanced motion/3D continuity, interactive story variants and multimodal retrieval.
- **Exit:** measured improvements in quality, cost, reliability or user outcomes justify each capability.

## 8. Priority backlog with acceptance evidence

| ID | Feature | Priority | Dependencies | Minimum acceptance evidence |
|---|---|---|---|---|
| CORE-01 | Canonical project/asset/job domain map | P0 | Repository audit | Entity ownership map; no duplicate source of truth |
| CORE-02 | Durable publication chain | P0 | Existing PR #172–178 chain | Race/fault tests; exactly-once observable finalization |
| CORE-03 | Private durable storage + restore | P0 | Runtime/storage | Unauthorized access tests; checksum and restore drill |
| CORE-04 | Tenant authorization audit | P0 | Auth/runtime | Negative cross-tenant tests for every resource route |
| CORE-05 | Cost reservation/settlement | P0 | Provider workers | No double debit on retries; ambiguous outcome reconciliation |
| CORE-06 | End-to-end production journey | P1 | P0 | Authenticated brief-to-master export test |
| EDIT-01 | Timeline preview/export parity | P1 | Media runtime | Frame/audio comparison fixtures |
| EDIT-02 | OTIO interchange | P1 | Timeline model | Import/export round-trip + unsupported-feature report |
| EDIT-03 | Quality preflight | P1 | Render pipeline | Deterministic fixtures for every gate |
| INT-01 | Creative Intent Graph persistence | P1 | Project document model | Reload, version, change-impact tests |
| INT-02 | Proof-to-Publish ledger | P2 | Intent + asset lineage | Claims trace to sources and final frames |
| INT-03 | Project Canon continuity | P2 | Asset indexing | Reference/continuity regression fixtures |
| DAM-01 | Semantic media index | P2 | Private storage, transcription/vision adapters | Search relevance, ACL isolation, deletion propagation |
| TRUST-01 | Rights/consent scope engine | P2 | Domain model | Expiry/revocation and prohibited-use tests |
| TRUST-02 | C2PA inspect/preserve/export | P2 | Media metadata pipeline | Valid, invalid, missing and unknown credential fixtures |
| COLLAB-01 | Exact-revision review/approval | P3 | Project permissions | Stale approval cannot approve a changed revision |
| BRAND-01 | Multi-brand governance | P3 | Current brand kit | Brand version, claims, template and project isolation tests |
| LOCAL-01 | Localization workflow | P3 | Voice/transcription adapters | Glossary, timing and reviewer acceptance tests |
| ACCESS-01 | Accessibility preflight | P3 | Timeline/caption/player | WCAG-focused automated and manual test evidence |
| BIZ-01 | Client scope and budget | P4 | Workspace roles | Estimate-to-actual variance and audit tests |
| BIZ-02 | Invoice and profitability | P4 | Time/cost ledger | Reconciled totals; no unverified cost assumptions |
| PUB-01 | Destination publishing adapters | P5 | OAuth, approvals | Idempotent publish, receipts, revoke and failure tests |
| LEARN-01 | Campaign experiment ledger | P5 | Analytics snapshots | Metric provenance/freshness; no causal overclaim |
| AI-01 | Blind model evaluation | P6 | Quality rubric, model registry | Reproducible benchmark set and cost capture |
| AI-02 | Adaptive routing/fallback | P6 | AI-01, capability contracts | Policy tests for privacy, quality, budget and outage |

## 9. Feature lifecycle and release evidence

Every feature must carry one explicit state:
- **Discovered:** user problem and public evidence recorded.
- **Specified:** UX, domain model, API contract and acceptance criteria approved.
- **Implemented:** production code exists.
- **Locally verified:** unit, typecheck, build and relevant integration tests pass.
- **Adapter verified:** real provider/utility behavior tested with a safe fixture.
- **Staging accepted:** authenticated end-to-end workflow passes in staging.
- **Production enabled:** separate explicit release approval, operational monitoring and rollback plan exist.

A catalogue entry or UI control is not proof of implementation. A provider adapter that is configured but not tested is not verified. A staging success is not production approval.

## 10. Security, privacy, safety and cost guardrails

- No provider secret in client code, source control, logs, error responses or browser storage.
- No private asset URL without authorization and short-lived access control.
- No cross-workspace inference, semantic search or cache leakage.
- No unbounded model calls, file sizes, render durations, polling or retries.
- No paid provider call without estimate, reservation, explicit user approval and idempotency.
- No publish, share, deletion or irreversible rights action without explicit confirmation and audit.
- No generation using likeness/voice references without documented permitted scope and consent checks.
- No claim that C2PA validates truth or ownership; describe exactly what was signed and verified.
- Preserve user data portability and provide deletion/export controls with retention disclosure.
- Keep free/local workflows viable where practical; disclose storage, compute and provider costs before activation.

## 11. Commercial packaging hypothesis

Do not lock pricing before measuring cost-to-serve and user demand. Validate a tier model:
- **Starter:** project planning, local media utilities, basic assets and limited workflows.
- **Creator:** advanced editing, reusable templates, more storage and controlled provider usage.
- **Studio:** collaboration, review, brand governance, localization and shared budgets.
- **Agency/Business:** client portals, multiple brands, approvals, cost accounting, audit and publishing.
- **Enterprise:** SSO, policy controls, retention, private deployment options, audit exports and negotiated limits.

Charge transparently for storage, rendering and paid provider usage; do not hide third-party consumption behind ambiguous credits.

## 12. Definition of "original, professional, not vibe-coded"

A release is acceptable only when:
- Domain logic is typed, validated and covered by tests.
- APIs have authorization, validation, pagination, rate limits and consistent errors.
- Data changes are versioned/migratable and have rollback/backup strategy.
- Async work is idempotent, recoverable and observable.
- UI has real empty/loading/error/partial/success states and accessible interactions.
- Every action maps to a real backend operation or is clearly labelled as a draft.
- No dead controls, fake progress, silent failures or invented provider capability.
- A complete user journey passes with realistic fixtures and staging configuration.
- Design is coherent, task-specific and usable on desktop/tablet/mobile.
- Operational docs cover setup, monitoring, cost, incident recovery and support.

## 13. Research source register (public first-party / standards references)

- Adobe creative agent and multi-step workflows: https://news.adobe.com/news/2026/06/adobe-unveils-major-expansion
- Frame.io V4 API overview and relationship-based access/custom fields/shares: https://developer.frame.io/platform/docs/overview
- Frame.io V4 resource hierarchy and version stacks: https://developer.frame.io/platform/docs/getting-started
- Frame.io V4 developer platform and workflow automations: https://developer.dev.frame.io/
- Runway typed node workflows and compatible media ports: https://help.runwayml.com/hc/en-us/articles/45763528999699-Introduction-to-Workflows
- Runway API async task lifecycle: https://docs.dev.runwayml.com/
- OpenTimelineIO editorial interchange model and limitations: https://opentimelineio.readthedocs.io/en/latest/
- C2PA specifications and implementer/security guidance: https://spec.c2pa.org/
- C2PA 2.4 specification, provenance, manifests, ingredients and AI disclosure: https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html
- Adobe Content Credentials export workflow: https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-videos-with-content-credentials.html
- W3C WCAG 2.2 Recommendation: https://www.w3.org/TR/wcag/
- Frame.io release notes on Content Credentials and forensic watermarking: https://updates.frame.io/

Research caveat: competitor feature descriptions are limited to public documentation and may vary by subscription, geography, beta status and API availability. Re-check before implementing adapters. All original adaptations and prioritization are product-design inferences.

## 14. Immediate next engineering actions

1. Re-audit the live main branch and all open PR heads; do not rely on old branch ancestry or previous summaries.
2. Build a dependency graph for the P0 publication/worker/storage PR chain and identify the canonical branch to reconcile first.
3. Run current CI/test evidence for main and the exact P0 heads; inspect failing tests, review comments and changed-file overlap.
4. Reconcile only one dependency slice at a time; never merge a large divergent integration PR simply to expose hidden features.
5. Close the P0 security/recovery gaps before turning on paid providers or external publishing.
6. Deliver one complete staging journey before broad P2/P3 feature expansion.
7. Keep this document updated in the same PR whenever priorities, acceptance evidence or implementation status change.

## 15. Non-negotiable project protections

- Inspect before modifying.
- Staging-first; production untouched unless separately approved.
- No destructive migration, deployment, provider charge or public publishing without explicit authorization.
- Preserve current production resources and existing user data.
- Push work on focused branches; open reviewable PRs; merge only exact verified heads.
- Report exact commit, PR, test outcomes, blockers and what remains unverified.


## 16. Live repository audit snapshot (2026-11-08)

This snapshot was taken after the plan was drafted. It is evidence for prioritization, not approval to merge.

### P0 publication chain: open PR evidence

| PR | Purpose | Branch comparison | Latest observed CI | Assessment |
|---|---|---|---|---|
| #172 | Unique worker lease/fencing tokens | 37 commits ahead of its declared base; 0 behind | Quality checks passed | Dependency candidate; validate exact base and integration before promotion |
| #173 | Structured lease lifecycle telemetry | Diverged: 8 ahead / 3 behind its declared base | Quality checks passed | Rebase/reconcile before promotion |
| #174 | Isolate immutable publication attempts | 7 ahead / 0 behind its declared base | Quality checks passed | Candidate dependency slice |
| #175 | Lease-aware orphan publication recovery | 33 ahead / 0 behind its declared base | Quality checks passed | Candidate dependency slice; inspect overlap with #178 |
| #177 | Atomic lease-fenced asset publication | Diverged: 26 ahead / 1 behind its declared base | Build failed | Blocked; observed failing assertion: "Missing expected rejection." Do not promote until fixed and re-run |
| #178 | Atomic publication under worker lease, audit API, cleanup worker and PostgreSQL integration tests | 137 ahead / 0 behind its declared base; 32 files changed | Build passed | Strongest current integration candidate by CI evidence, but draft and review still required; large commit distance requires careful ancestry/diff review |

The declared bases form a dependency chain around #172 → #174 → #175, with #173 on a diverged telemetry branch and #177/#178 competing atomic-publication paths. Do not merge #177 and #178 together by default. Determine which path is canonical, whether #178 already subsumes earlier commits, and whether all migrations are ordered and safe before promotion.

### Other open work
- #193 is a draft research PR; the canonical product plan is now recorded in this document on a focused branch instead of relying on that divergent research branch.
- #206 is a large draft integration candidate for billing, Google Drive and provider-aware workers. It must be decomposed and reviewed by dependency, not merged as one bulk integration.
- #194/#195/#204 contain Runway video-to-video, cloud video editing and video-to-audio work. Keep paid provider operations gated; verify provider contracts, cost reservations, cancellation and staging tests before enabling.
- #207/#208 extend publication cleanup and source-attributed cost estimation. Re-evaluate their bases and test evidence after selecting the canonical publication chain.

### Main-branch ancestry check

A second comparison against the actual current `main` exposed a critical integration constraint:

- `feat/atomic-asset-publication-pr` (#178 head) is **238 commits ahead and 25 commits behind main**, with 43 files in the comparison.
- `feat/durable-publication-cleanup` (#175 head / #178 base) is **101 commits ahead and 25 commits behind main**, with 25 files in the comparison.
- Therefore, the green #178 workflow is not a green build on current main and is not a merge-ready release candidate. Its branch contains a substantial history divergence and needs a controlled rebase/cherry-pick or equivalent reconciliation into a fresh branch from current main.
- The 43-file comparison includes overlapping core runtime files, worker/queue code, delivery manifest, migrations and CI. Resolve those conflicts and rerun full CI on the reconciled exact head.
- #177's observed failed assertion is a useful test signal, not a reason to bypass the competing #178 path. Keep #177 unpromoted until its failure is understood and the canonical implementation is chosen.

**Updated recommendation:** do not merge #172–#178 as a mechanical PR stack and do not merge #178 directly to main. First construct a fresh integration branch from current main, port only the verified dependency slices in order, run migration/SQL concurrency tests against PostgreSQL, run the full build, then perform a staging restore and end-to-end publication test. Keep the existing branches untouched as evidence until the fresh branch passes.

### What this audit did and did not prove
- The listed CI observations are the latest workflow-run results found for the inspected commit SHAs at audit time; they are not a substitute for rerunning checks after any rebase or merge.
- PR review submissions and inline review threads were empty for #172–#178 at the time checked. Absence of review comments is not approval.
- A green build proves only the checks configured in that workflow. It does not prove production readiness, storage restore, tenant isolation, billing correctness or provider acceptance unless those tests explicitly cover them.
- No code, database, provider settings, deployment or production resource was changed during this audit.


---

## 12. Implementation update — 8 November 2026: CAI verification foundation

The first real C2PA implementation slice is now on feature branch `feat/c2pa-server-verification`.

### Delivered in this branch

- Pinned the maintained official `@contentauth/c2pa-node` package to `0.10.0` and synchronized the npm lockfile.
- Added a server-only adapter using `Reader.fromAsset`, `Context` and the SDK's manifest `validation_state`.
- Connected verification to the existing authenticated `GET /api/assets/:assetId/provenance` route after asset authorization.
- Added a per-asset Verify Content Credentials action in the Asset Library and a results panel for manifest state, trust status and validation findings.
- Disabled remote manifest fetching and added file-backed parsing, byte-size checks and a default 250 MiB verification cap.
- Preserved bounded SDK validation findings and mapped `Invalid`, `Valid` and `Trusted` to explicit application states.
- Required an administrator-controlled PEM trust-anchor file before returning `valid_trusted`; without a configured trust policy the result is conservatively downgraded to `valid_untrusted`.
- Added deterministic adapter tests and a native-SDK integration smoke test using a generated valid PNG.
- Updated the Node runtime in CI and the Docker image to the Node 24 line; added C2PA verification to the build verification chain.
- Revised README, developer operations guide, provenance guide and implementation status.

### Remaining C2PA delivery gates

1. Run the full CI suite, including native package installation, genuine signed PNG and MP4 fixture generation with the upstream CAI test signer, trust-anchor validation and PNG pixel-tampering rejection.
2. Extend genuine signed/tampered fixtures to additional supported video and audio formats beyond MP4.
3. Verify timestamp, revocation and production trust-list behavior against a reviewed trust policy.
4. Add parser isolation and enforceable CPU/memory/time limits.
5. Provision and review a protected KMS/HSM provider; the callback adapter and cloud media worker hook exist, but production signing stays disabled.
6. Extend ingredient-aware manifest creation from the current cloud media derivative hook into timeline render, export and publishing.
7. Verify the final output after every supported proxy, transcode, timeline render and export operation.
8. Test cross-user and cross-project denial through the actual provenance endpoint.

### Release posture

This branch is implementation work, not a production release. Do not merge to `main` or deploy until native SDK CI, genuine signed fixtures, security review, full user journey and isolated staging gates pass. No production service, shared database, production storage or signing key has been modified.


## 13. Implementation update — 8 November 2026: protected callback signer and cloud-worker hook

A server-only `server/c2pa-signing.mjs` adapter is implemented on `feat/c2pa-protected-signing`.

- Uses the official CAI `Builder` and `CallbackSigner` APIs. Private-key operations are delegated to an injected `signingProvider.sign({ keyRef, algorithm, payload })` callback; the application receives only a public certificate chain and opaque key reference.
- Requires an HTTPS timestamp authority by default and a dedicated private workspace root (`C2PA_SIGNING_MEDIA_ROOT`) matching `CLOUD_WORKER_TEMP_ROOT`.
- Distinguishes the already-transformed bytes (`inputPath`) from the original parent (`sourcePath`) and the new signed destination. This prevents a false lineage claim where the signer merely re-signs the unmodified source.
- Preserves an existing source manifest through `addIngredientFromReader`; for unsigned sources it explicitly records the original source as a file-backed parent ingredient.
- Records a `c2pa.edited` action, signs the transformed bytes, reopens and validates the output, and returns checksum/size/ingredient metadata. Partial outputs are removed on failure.
- `createCloudMediaExecutor` and `createCloudMediaWorker` now accept an optional signer callback. When supplied, the cloud media worker signs a validated derivative before durable publication, checks the returned checksum/size, re-probes the signed media and stores the C2PA result with the derivative metadata.
- Integration tests exercise two actual changed PNG outputs in sequence, preserve the first signed asset as the next ingredient, and test that the cloud media executor publishes the signed file rather than the unsigned intermediate.
- GitHub Quality checks passed on the latest full build and PostgreSQL publication/cleanup integration run.

This is still not production signing: the default `cloud-worker-process` does not instantiate a KMS/HSM provider, no production certificate or TSA is configured, and local timeline render/export is not connected. Keep `C2PA_SIGNING_ENABLED=false`. Next steps are protected provider provisioning and review, production certificate/rotation/revocation policy, timestamp trust, additional video/audio format fixtures, and timeline/export integration.


## Delivered integration update — Creative Intelligence Graph

The AI Director now reads cloud production records, proof candidates, character bibles, episode scenes/shots, private project assets and cloud timeline documents into one explicit dependency graph. It connects only persisted IDs and references (including story-bible references, timeline markers and clip asset IDs), separates project-scope membership from authored relationships, and computes downstream review impact without changing source records. README usage guidance and automated graph tests are included. Remaining graph work: connect evidence records with durable source IDs, introduce project-wide scene/shot identifiers for non-series productions, and propagate revision/staleness state into exports and publishing.


### Evidence intelligence implementation checkpoint
- Implemented a durable evidence ledger with source asset hash snapshots, explicit target references, role-gated review and append-only event history.
- Build gate: `npm run verify:evidence-ledger`.
- Integrated authorized project evidence records into the Creative Intelligence Graph. Only verified records with matching source SHA-256 and a resolvable same-project target create supporting edges; unresolved or non-verified records remain review-only.
- Next: implement revision-aware evidence invalidation and downstream stale-impact propagation across shots, timelines, variants, exports and publishing.


### Revision-aware change propagation checkpoint
- Added immutable per-project Creative Intelligence Graph baselines and graph-hash revisions.
- AI Director compares the current graph with the latest reviewed baseline and identifies changed nodes plus downstream potentially stale dependencies.
- Next: connect these review signals to durable timeline/export/variant/publishing revision records and require explicit reapproval where dependencies changed. No automatic invalidation or publication block exists yet.


### Production execution hardening checkpoint
- Added graceful cancellation for active media/timeline jobs on worker shutdown, with explicit `cancelled` terminal status while the lease is valid and durable recovery fallback when finishing cannot be confirmed.
- Next: reconcile storage publication and cleanup failure paths, then run multi-role authorization and retry/replay acceptance tests before enabling worker services in staging.
