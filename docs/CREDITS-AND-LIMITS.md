# Credits and usage limits

Credits keep paid AI usage under control. Each signed-in person gets free credits every day. Using a paid provider (image, video, voice, text) costs credits. Local processing that costs nothing is never charged.

## Switch it on

In your hosting settings (for example Render, under **Environment**):

| Name | Value |
| --- | --- |
| `CREDITS_ENABLED` | `true` |
| `CREDITS_DAILY_FREE` | Optional. Free credits topped up each day. Default `20`. `0` means no free credits. |

Redeploy. A **✦ credits** chip appears in the top bar for signed-in people. Hover it to see the cost of each kind of request.

## How it works

- **Daily free credits:** a person's balance is topped up to the daily amount once per day (UTC). A top-up never lowers extra credits an administrator gave them.
- **Costs:** text 1, voice 2, transcription 1, image 3, video 15. Anything else costs 1. They are set in `server/credits.mjs`.
- **Not enough credits:** the request is refused with a plain message and nothing is charged. It also does not use up the daily request limit (`REMOTE_AI_DAILY_REQUEST_LIMIT`), which still applies on top of credits.
- **Adding credits:** an administrator opens **Security operations → Add credits**, enters the person's sign-in email and an amount. The person must have opened the app at least once. Each grant is written to the admin audit log with hashes only.
- **Privacy:** emails are stored only as hashes (HMAC when `AUTH_IDENTIFIER_HMAC_KEY` is set), and the server checks everything. The browser only displays the balance.

## Limits to know about

- Balances live in the app database. Without a persistent disk (Render's free plan), they reset when the service is redeployed or restarted after sleeping for a long time.
- Credits are taken when a paid request starts. A request that fails afterwards is not refunded automatically yet.
- This is a usage budget, not payments. Taking money for credits is a separate step.
