# Gemini Nano Banana Pro image adapter

**Date:** 2026-11-07  
**Scope:** First direct Google Gemini image-generation adapter for Executive Visuals.

## Implemented in this slice

- Server-side REST integration with Google Gemini `generateContent`.
- Official Nano Banana Pro model ID: `gemini-3-pro-image`.
- Text-to-image and one-reference image-to-image input.
- 1K/2K output mapping for the existing square, landscape and portrait UI presets.
- Image payload parsing, response size bounds and handoff to existing generated-asset signature validation.
- Integration with approval-gated workflow execution, usage reservation, usage metadata and private asset storage.
- Provider registry readiness and UI model visibility.
- Fake HTTP tests only; no paid generation request is sent by CI.

## Release boundary

This adapter supports Nano Banana Pro only. It does not yet implement multi-turn editing sessions, multiple references, search grounding, video input, 4K UI controls or other Nano Banana model variants. Do not present those as available until separately implemented and tested.

Nano Banana Pro is a paid API model and the official pricing page states no free tier for this model. The adapter remains disabled unless the owner supplies a server-side key, enables the image gateway and explicitly opts into remote execution. No key is committed and no live request was made.

## Configuration

```dotenv
IMAGE_GATEWAY_PROVIDER=gemini
IMAGE_GATEWAY_ENABLED=true
IMAGE_GATEWAY_ALLOW_REMOTE=true
GEMINI_API_KEY=<server-side secret>
GEMINI_IMAGE_MODEL=gemini-3-pro-image
```

Keep credentials out of browser code, project JSON, logs and public repositories. Do not enable this on the Free Render deployment without reviewing provider charges and persistent storage limits.

## Official references

- Nano Banana Pro model card: https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image
- Image generation and editing: https://ai.google.dev/gemini-api/docs/image-generation
- Gemini API pricing: https://ai.google.dev/gemini-api/docs/pricing
