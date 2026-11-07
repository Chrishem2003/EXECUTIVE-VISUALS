# Gemini Nano Banana Pro image adapter

**Date:** 2026-11-07  
**Scope:** Direct Google Gemini image-generation adapters for Executive Visuals.

## Implemented in this slice

- Server-side REST integration with Google Gemini `generateContent`.
- Official Nano Banana Pro model ID: `gemini-3-pro-image`.
- Official Nano Banana 2 model ID: `gemini-3.1-flash-image`, a lower-cost, higher-throughput alternative.
- Text-to-image and one-reference image-to-image input.
- 1K/2K output mapping for the existing square, landscape and portrait UI presets.
- Image payload parsing, response size bounds and handoff to existing generated-asset signature validation.
- Integration with approval-gated workflow execution, usage reservation, usage metadata and private asset storage.
- Provider registry readiness and UI model visibility.
- Fake HTTP tests only; no paid generation request is sent by CI.

## Release boundary

This adapter supports Nano Banana Pro and Nano Banana 2. It does not yet implement multi-turn editing sessions, multiple references, search grounding, video input, 4K UI controls or other Nano Banana model variants. Do not present those as available until separately implemented and tested.

Both models require a paid API plan for image generation. Provider prices and billing eligibility can change; consult the official Google Gemini API pricing page before enabling remote generation. These are upstream provider charges, not Executive Visuals subscription prices. The adapter remains disabled unless the owner supplies a server-side key, enables the image gateway and explicitly opts into remote execution. No key is committed and no live request was made.

## Configuration

```dotenv
IMAGE_GATEWAY_PROVIDER=gemini
IMAGE_GATEWAY_ENABLED=true
IMAGE_GATEWAY_ALLOW_REMOTE=true
GEMINI_API_KEY=<server-side secret>
GEMINI_IMAGE_MODEL=gemini-3-pro-image  # or gemini-3.1-flash-image
```

Keep credentials out of browser code, project JSON, logs and public repositories. Do not enable this on the Free Render deployment without reviewing provider charges and persistent storage limits.

## Official references

- Current Gemini model catalogue: https://ai.google.dev/gemini-api/docs/models
- Nano Banana Pro model card: https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image
- Image generation and editing: https://ai.google.dev/gemini-api/docs/image-generation
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
