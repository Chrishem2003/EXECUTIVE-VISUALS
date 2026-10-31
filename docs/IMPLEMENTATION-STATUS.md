# Executive Visuals — implementation status

**Updated:** 31 October 2026  
**Branch:** `feat/executive-visuals-unified-platform`  
**Delivery posture:** local-first foundation; production integrations remain gated.

## Implemented in the current branch

| Area | Implemented behavior | Boundary |
|---|---|---|
| Product shell | Unified browser application with dedicated workspaces | Local-first prototype |
| Capability explorer | Search and domain filters; displays stable ID, inputs, outputs, evidence, execution modes and approval gates | Registry browsing only; does not dispatch jobs |
| Capability registry | 60 typed capability definitions across 22 domains | Specification/readiness metadata, not provider availability |
| Machine-readable catalog | JSON catalog generated from the typed registry | Build verifier enforces ID/domain/label parity |
| Workflow graph | Typed node kinds, semantic media ports, graph edges and node configuration | No persisted server-side graph service yet |
| Graph validation | Duplicate IDs, missing nodes/ports, incompatible ports, duplicate single-input edges, required inputs and cycle detection | Validation only; no provider calls |
| Targeted execution planning | Full graph, single-node and selected-subgraph dependency planning | Produces a plan only; does not execute jobs |
| Output locking | Locked nodes with saved output IDs are reused; targeted reruns can stop at locked ancestors | Durable output storage is not connected |
| Job/run contracts | Workflow snapshot, budget ceiling, approval metadata, node-run and normalized state contracts | No durable queue/worker implementation yet |
| Quality checks | Capability registry verifier and workflow planner tests are part of the build | CI verifies code/contracts, not external provider behavior |

## Build verification

The build pipeline runs:
1. Capability catalog parity and completeness checks.
2. Workflow graph validation and targeted-run behavior checks.
3. TypeScript typecheck.
4. Production Vite build.

A green build proves the local contracts and application compile. It does not prove that a paid generation provider, remote storage service, rendering engine or collaboration service is connected.

## Not yet production-complete

- Provider adapters, live model discovery, credentials vault and provider contract conformance.
- Paid job submission, durable queue, webhook verification, retries and cancellation.
- Persistent cloud asset storage, checksum ingestion, retention and signed downloads.
- Frame-accurate timeline editing, playback, proxy/original relinking and final rendering.
- Voice generation, transcription, dubbing and lip synchronization integrations.
- 3D rendering, local compute workers, hardware-aware model management and render-farm scheduling.
- Live capture, remote recording and stream ingest.
- Multi-user tenancy, comments, review links, approval workflows and audit persistence.
- Publishing, channel analytics and campaign performance feedback.

## Safety and delivery rules

- Do not present a planned capability as available.
- Do not send paid provider requests without explicit approval and a cost estimate.
- Keep provider credentials server-side.
- Preserve original assets and immutable run snapshots.
- Record provenance, consent and source rights.
- Keep production deployment and production credentials untouched until staging verification is complete.
