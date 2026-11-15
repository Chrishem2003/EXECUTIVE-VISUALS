# Review-first video caption localization

The Workflow Studio template **Video → localized captions** creates a reusable, saved graph:

1. Select an existing private source video by asset ID.
2. Extract its audio through the existing deterministic media worker.
3. Require an upstream human approval before transcription.
4. Transcribe through the configured server-side speech gateway.
5. Present the transcript as an approval ancestor before translation.
6. Translate timed cues into a configured target language.
7. Generate a separate WebVTT caption asset and export it as a deliverable.

## Safety and behavior

- The source video is never overwritten.
- The source asset ID is blank by default; the user must select an existing asset.
- Owner/project authorization and media validation remain server-side.
- Both remote AI steps require completed human-approval ancestors and configured server-side gateways.
- Remote gateway access and usage reservations remain disabled unless configured and approved.
- Translation preserves cue order and timestamps; it changes cue text only.
- The output is a caption sidecar, not a video with burned-in or muxed captions.
- The template creates no provider request when loaded or saved.

## Verification

The graph tests validate typed ports, graph connectivity, execution planning, the two approval edges and explicit source selection. Full verification is required before merge.
