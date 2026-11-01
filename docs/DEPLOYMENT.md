# Deployment guide

This is a status-first guide: it says what was checked, what was not, and what you must decide before going live.

## What was verified

`npm run build` runs every verifier and the full server test suite. `npm run smoke:production` then copies exactly what the Docker runtime image contains (`package.json`, `server/`, `dist/`, the account script) into a temp directory and checks, over real HTTP:

- production mode refuses `AUTH_MODE=local` (by design)
- health reports FFmpeg and FFprobe and leaks no secrets
- the app shell is served with anti-framing headers
- an operator-made account signs in, a wrong password does not
- a video uploads, a local FFmpeg job runs on the queue, and the result downloads and probes correctly
- a gateway job with no configuration ends as `blocked` with its reason, and nothing is sent anywhere
- accounts and files survive a server restart on a persistent data directory

## What was not verified

- **The Docker image itself was never built or run** (no Docker daemon was available where this was developed). The Dockerfile is plain, but build it once before trusting it: `docker build -t executive-visuals .`
- Supabase sign-in, cloud storage and the cloud worker, which need your own Supabase project.
- Any real provider. Every gateway engine was tested against local mock servers only.

## Decide before going live: how people sign in

The server will not start with `NODE_ENV=production` and `AUTH_MODE=local`, because local passwords are development-only. The committed `render.yaml` sets exactly that pair, so **it will fail to boot as written**. Pick one:

1. **Supabase auth (intended for production).** Set `AUTH_MODE=supabase`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, apply the isolated migration, and review storage policies. Nothing else needs to change.
2. **Private staging with local accounts.** Do not set `NODE_ENV=production`; set `AUTH_MODE=local`, keep the service private (VPN, tunnel or IP allow-list), and create accounts with the operator script below. **Outside production, `/api/auth/register` is open to anyone who can reach the service**, so the network restriction is what protects it, not the app.
3. **A deliberate single-operator production opt-in.** Not implemented, because it weakens a guard the project chose on purpose. Ask for it explicitly if you want it.

## Creating accounts without open sign-up

```
EV_PASSWORD='a long passphrase' npm run user:create -- you@example.com
EV_PASSWORD='a new passphrase'  npm run user:create -- you@example.com --reset
```

The password never appears on the command line. A reset ends all existing sessions.

## Environment checklist

| Variable | Why |
|---|---|
| `DATA_DIR`, `DB_FILE`, `MEDIA_ROOT` | Must sit on a persistent volume. With `REQUIRE_PERSISTENT_DATA_DIR=true` the server refuses to start if the volume is missing |
| `API_HOST=0.0.0.0` | Needed inside a container |
| `AUTH_MODE` and its keys | See the sign-in decision above |
| `*_GATEWAY_*` | One block per engine in `.env.example`. Keep keys server-side. Remote HTTPS needs `*_ALLOW_REMOTE=true` |
| `REMOTE_AI_DAILY_REQUEST_LIMIT` | Caps paid requests per account per day |
| `MAX_UPLOAD_BYTES` | Upload ceiling (default 250 MiB) |

## Capacity notes

- Jobs run in the same process as the API. For heavier use, set `DISABLE_WORKER=true` on the web instance and run a separate worker; multi-host workers need the shared Postgres queue, which is not deployed yet.
- Video work is CPU-bound FFmpeg. Size the instance for the longest clip you expect, and keep a single instance until the shared queue exists, because SQLite lives on one disk.
- Generated media accumulates on the volume. There is no automatic retention policy yet.
