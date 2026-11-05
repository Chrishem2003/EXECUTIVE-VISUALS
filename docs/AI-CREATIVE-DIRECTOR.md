# Model-backed Creative Director

**Milestone:** P1.3  
**Status:** Implemented behind the existing text gateway configuration; requires an explicit user request and a configured gateway.  
**Execution boundary:** Text reasoning only. No media generation, provider job, timeline mutation or publication is performed.

## What it does

The deterministic Creative Intent compiler remains available as an instant, no-model fallback. The separate model-backed path accepts a bounded creative brief and asks the configured server-side text gateway to return a structured proposal containing:

- Creative promise, audience contract and strategic thesis.
- Emotional journey and distinct hook angles.
- Visual grammar and sound identity.
- Ordered story beats and production principles.
- Channel-aware distribution cuts.
- Proof, rights and disclosure checks.
- Explicit assumptions, open questions and risk flags.
- Two or three creative routes with their trade-offs.

The output is validated against a strict schema before it is returned. Malformed or incomplete output is rejected; it is never silently converted into a plan. The plan records its source, configured model, generation time and SHA-256 fingerprint of the normalized input. Token usage is returned when the gateway reports it.

## Runtime and security

The endpoint is `POST /api/creative/director`. It requires an authenticated workspace session and is rate-limited to five requests per minute per remote address. If a project ID is supplied, the server verifies that the caller is the owner or an editor before making a model request and associates the audit event with that project. The request body is capped at 16 KiB and individual fields have explicit length limits.

The server uses the existing OpenAI-compatible text gateway configuration:

- `AI_GATEWAY_ENABLED=true`
- `AI_GATEWAY_URL`
- `AI_GATEWAY_MODEL`
- Optional server-only `AI_GATEWAY_API_KEY`
- Remote gateways additionally require HTTPS and `AI_GATEWAY_ALLOW_REMOTE=true`

The browser never receives the gateway API key. The server writes an audit event containing model, input fingerprint and reported token counts; it does not store the raw brief in the audit event. The UI asks for confirmation before sending the brief because a remote text model may incur charges. The model call is not automatic on page load or on deterministic compilation.

## Human review and trust

The brief is treated as untrusted data. The model is instructed not to follow embedded prompt-injection requests, invent factual proof, assume rights or consent, or invoke tools. The response must identify assumptions and questions, and distinguish proposed story treatment from verified claims.

Model output is a proposal, not an approved script or a factual research report. Human review is required before storyboard compilation, provider generation, export or publication. This stage does not execute any of those actions.

## Verification

- Unit tests cover bounded inputs, structured response parsing, required fields, duplicate rejection, route alternatives, provenance and invalid model output.
- API tests use a local mock OpenAI-compatible endpoint and verify authentication, the configured model boundary, secret non-disclosure, malformed-output rejection and that invalid input does not reach the model.
- The tests are included in `verify:creative-director` and the production build verification chain.

## Next stage

P1.4 will consume the reviewed direction and compile an editable storyboard with scenes, shots, character references, continuity constraints, proof anchors and provider-neutral prompts. It must preserve the source brief and director decisions as lineage, and must not submit media jobs.
