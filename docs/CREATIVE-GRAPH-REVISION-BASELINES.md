# Creative graph revision baselines and change impact

**Status:** project-scoped review baselines, revision comparison and downstream stale-candidate analysis are implemented on the feature branch. This is a review aid, not an automatic production invalidation engine.

## Workflow

1. Open a cloud project in AI Director. The application loads its saved creative production, assets, evidence, timelines and latest graph baseline.
2. Review the connected graph. An owner or editor selects **Record current graph as review baseline** after a meaningful review checkpoint.
3. The API validates the graph shape, node/edge types, unique node IDs, project-node identity and edge endpoints, then stores a normalized immutable snapshot with a monotonically increasing per-project revision and SHA-256 graph hash.
4. When the current graph differs from the saved baseline, the application compares node content and explicit relationships, identifies added/removed/changed nodes, and walks downstream dependencies in the current or baseline graph.
5. Potentially affected shots, clips, timelines and other dependencies are shown for human review before downstream work is accepted.

## API

- `GET /api/projects/:projectId/creative-graph/snapshot` — latest authorized project baseline, or `snapshot: null`.
- `POST /api/projects/:projectId/creative-graph/snapshot` — create a new baseline. Owner/editor access is required. Body: `{ "graph": { "nodes": [...], "edges": [...] } }`.

The server accepts at most 1,000 nodes and 5,000 edges. It requires the matching `project:<projectId>` node, unique bounded node IDs, supported node/status/relation types, and edges whose endpoints exist in the submitted graph. Snapshots are append-only by project revision; the API does not overwrite previous baselines.

## Change comparison semantics

- Node content and explicit authored/dependency edges participate in fingerprints.
- Project-scope membership edges are excluded from node fingerprints so adding one child does not falsely mark every project item as changed.
- Added, removed and changed nodes are listed separately.
- Downstream traversal uses the directed edges in the current graph for surviving/added nodes and the saved baseline for removed nodes.
- Downstream items are labelled **potentially stale / review required**, not conclusively stale. The application does not mutate timeline revisions, delete exports, block publication or silently change approval state.
- A reviewer must inspect the impact and explicitly update/reapprove affected work. Future work will connect this review signal to export and publishing release gates.

## Validation

Run `npm run verify:creative-graph` and `npm run verify:creative-graph-snapshot`. The full application build includes both gates.
