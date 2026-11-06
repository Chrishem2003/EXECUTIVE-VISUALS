# Connecting AI generators

The generators are already built into the server. They stay off until you give them a provider and a key in your hosting settings (for example Render, under **Environment**). Keys go only there. Never paste a key into a chat, an issue or the code.

Turn on **credits** (see `CREDITS-AND-LIMITS.md`) first, so spending stays capped.

Every paid request is also limited by `REMOTE_AI_DAILY_REQUEST_LIMIT` (default 50 per person per day). Generation steps in workflows run only after a human-approval step, and run through the background worker, so leave `DISABLE_WORKER` unset.

## Text (scripts, prompts, summaries, translation)

Works with any provider that offers an OpenAI-style chat endpoint, including several with free tiers.

| Name | Value |
| --- | --- |
| `AI_GATEWAY_ENABLED` | `true` |
| `AI_GATEWAY_ALLOW_REMOTE` | `true` |
| `AI_GATEWAY_URL` | The provider's base URL (must be `https://`), for example `https://api.groq.com/openai/v1` or `https://openrouter.ai/api/v1` |
| `AI_GATEWAY_MODEL` | A model name from that provider's catalog |
| `AI_GATEWAY_API_KEY` | Your key from that provider |

## Images

Option A, any OpenAI-style image endpoint:

| Name | Value |
| --- | --- |
| `IMAGE_GATEWAY_ENABLED` | `true` |
| `IMAGE_GATEWAY_ALLOW_REMOTE` | `true` |
| `IMAGE_GATEWAY_URL` | Provider base URL (`https://`) |
| `IMAGE_GATEWAY_MODEL` | Model name |
| `IMAGE_GATEWAY_API_KEY` | Your key |

The provider must return the image as base64 (`b64_json`).

Option B, FAL:

| Name | Value |
| --- | --- |
| `IMAGE_GATEWAY_ENABLED` | `true` |
| `IMAGE_GATEWAY_ALLOW_REMOTE` | `true` |
| `IMAGE_GATEWAY_PROVIDER` | `fal` |
| `FAL_KEY` | Your FAL key |
| `FAL_IMAGE_MODEL` | A FAL image model ID from their catalog |

## Video (FAL)

| Name | Value |
| --- | --- |
| `VIDEO_GATEWAY_ENABLED` | `true` |
| `VIDEO_GATEWAY_ALLOW_REMOTE` | `true` |
| `FAL_KEY` | Your FAL key (same one as images) |
| `FAL_VIDEO_MODEL` | A FAL video model ID from their catalog |

## Voice

| Name | Value |
| --- | --- |
| `VOICE_GATEWAY_ENABLED` | `true` |
| `VOICE_GATEWAY_ALLOW_REMOTE` | `true` |
| `VOICE_GATEWAY_URL` | Provider base URL (`https://`) |
| `VOICE_GATEWAY_MODEL` | Speech model name |
| `VOICE_GATEWAY_API_KEY` | Your key |

For speech-to-text also set `VOICE_TRANSCRIPTION_ENABLED=true` and `VOICE_TRANSCRIPTION_MODEL`.

## Check it works

Open **Creative engines** after redeploying. A generator shows as ready when its settings are complete. Prices and free tiers change, so check each provider's current pricing before you enable one.

## Other generator work in this repository

About a hundred other branches on GitHub (Runway, Google video, Kie Seedance, Luma, FAL job queue, storyboard-to-timeline, audio mixer) were built on a separate line of history from the main branch, so they cannot be merged in one step. They also expect a PostgreSQL database and server-only secrets, which the free setup does not use. Port them one at a time when you move to paid hosting.
