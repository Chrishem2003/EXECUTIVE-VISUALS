# Executive Visuals

**One workspace for AI-directed visual production.**

Executive Visuals is an original, provider-independent creative production workspace that brings together avatar-led video, cinematic image/video creation, editing, enhancement, voice, and campaign workflows.

> This project is an independent implementation. It does not contain copied source code, proprietary assets, private APIs, or branding from third-party products.

## Product direction

- **Director** — briefs, scripts, shot lists, storyboards, and production plans.
- **Avatar Studio** — consent-based presenter profiles and avatar-video workflows.
- **Cinematic Studio** — image/video generation briefs with shot, camera, lens, lighting, and continuity controls.
- **Image Studio** — image creation, variations, and edit workflows.
- **Video Studio** — project timeline, scene assembly, captions, and export planning.
- **Enhancement Lab** — restoration, upscale, retouch, denoise, object removal, and background workflows.
- **Voice & Localization** — speech, voice profiles, transcription, translation, dubbing, and lip-sync workflows.
- **Campaign Studio** — product ads, UGC-style concepts, social variants, and batch briefs.
- **Asset Library** — project assets, references, reusable characters, brand kits, and outputs.

## Architecture principles

1. Provider-independent capability contracts; no vendor lock-in.
2. Local-first development with optional authorized cloud providers.
3. Explicit consent and rights checks for likeness, voice, and uploaded media.
4. Transparent job states, provider attribution, and estimated/actual costs.
5. Durable project/asset metadata with pluggable storage.
6. No secret values in browser bundles, logs, or committed files.
7. A capability is not marked available until its adapter is implemented and tested.

## Status

The repository is being bootstrapped from an empty GitHub repository. Initial milestone: a coherent application shell, documented capability map, provider/job architecture, and testable local development foundation. Actual generative output requires a configured local model or an authorized provider adapter.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup and configuration. See [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) for evidence standards and the independent implementation plan.
