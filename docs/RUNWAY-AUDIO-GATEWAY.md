# Runway audio processing gateway

This gateway adds two optional, paid remote operations to the workflow engine:

- `voice.isolate`: extracts clean dialogue from an approved audio asset.
- `voice.dub`: dubs an approved audio asset into a supported target language.

## Safety and enablement

The gateway is fail-closed. It does not submit requests unless all of the following server-side variables are explicitly configured:

```dotenv
RUNWAYML_API_SECRET=
RUNWAY_AUDIO_ENABLED=false
RUNWAY_AUDIO_ALLOW_REMOTE=false
```

Do not enable these flags in production until the owner has reviewed current provider pricing, data handling and the intended budget limits. Keep the secret in the hosting provider's encrypted environment settings; never expose it to the browser.

The workflow requires a human approval node before either remote operation. The source asset must belong to the requesting owner and project, pass path containment and SHA-256 checks, and remain within the 200 MiB upload limit. The source is never overwritten. Provider outputs are downloaded from the allowlisted HTTPS CloudFront host with a 100 MiB bound and stored as new private audio derivatives.

Voice cloning is disabled by default in the studio. Enabling it requires an explicit speaker-permission confirmation in the workflow, and the server independently rejects cloning requests without that confirmation. Use generic voice when permission is unavailable.

## Supported dubbing language codes

`en hi pt zh es fr de ja ar ru ko id it nl tr pl sv fil ms ro uk el cs da fi bg hr sk ta`

The provider may reject recordings outside its documented duration or media constraints. Voice isolation currently accepts audio between 4.6 seconds and one hour. Video sources must first pass through the existing audio-extraction node.

## Workflow construction

### Existing audio asset

1. Upload an audio asset into the private project.
2. Open Voice & Localization.
3. Choose voice isolation or dubbing and select the source audio.
4. Save the workflow and review the exact source/operation at the approval checkpoint.
5. After the administrator has explicitly enabled the gateway, approve the node to submit the provider task.
6. The completed audio derivative is saved to the same project with model, provider request and checksum provenance.

### Video dialogue dubbing

1. Select a private source video in Voice & Localization.
2. Confirm source-media rights and choose the target language.
3. Keep generic voice selected unless speaker permission for voice cloning is available and explicitly confirmed.
4. The workflow waits for approval, extracts the source video's audio locally, then submits the audio to the dubbing adapter.
5. The dubbed audio is saved as a private derivative for placement on the existing timeline. The source video is not overwritten. Automatic replacement/remux of the video's original audio track is a separate finishing step and is not claimed as complete by this adapter.

## Tests

Run:

```bash
node --test server/tests/runway-audio-gateway.test.mjs
node --test server/tests/runway-video-gateway.test.mjs
npm run verify:server
npm run build
```

This adapter does not enable itself, deploy itself, or spend provider credits during tests.
