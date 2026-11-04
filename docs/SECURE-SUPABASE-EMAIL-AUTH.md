# Secure Supabase email authentication

**Branch:** `feat/secure-supabase-auth-session`  
**Status:** implemented in code; CI and hosted acceptance pending. This does not approve public release.

## User experience

- The branded CHRISHEM EXCLUSIVE VISUALS sign-in page uses the user's email and password. It no longer asks users to paste an access token.
- Registration is sent to Supabase Auth. If email confirmation is required, the UI tells the user to check their inbox instead of pretending a session exists.
- Sign-in failures are generic. Three consecutive failures for an identifier trigger the existing progressive lockout policy (initially 15 minutes, increasing on repeated lockouts, capped at 24 hours).
- Password recovery sends a reset email through Supabase Auth. The recovery callback is verified server-side; access and refresh tokens are never returned to browser code. The user sets and confirms a new password through the authenticated server route.
- Logout revokes the Supabase session best-effort and clears the application cookie.

## Session security

- Supabase access and refresh tokens are encrypted together using AES-256-GCM with a random 96-bit IV and authentication tag.
- The browser receives only an opaque encrypted `ev_supabase_session` cookie marked `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` in production.
- API requests automatically verify the access token. When it is near expiry or Supabase returns 401, the server rotates the refresh token and replaces the cookie.
- The encryption key is derived from `SUPABASE_SESSION_SECRET` using SHA-256. Use a unique random secret of at least 32 characters. Do not reuse the Supabase service-role key, publishable key, JWT secret, or another application's secret.
- The secret is server-only. Never expose it in Vite variables, browser storage, logs, commits, or client responses.
- Same-origin API requests include cookies. The existing strict same-site cookie policy and origin checks remain in force.

## Required environment

Set these on the dedicated Executive Visuals staging service only:

- `AUTH_MODE=supabase`
- `SUPABASE_URL` — URL of the dedicated Executive Visuals Supabase project.
- `SUPABASE_PUBLISHABLE_KEY` — that project's publishable key.
- `SUPABASE_SESSION_SECRET` — a newly generated random secret (32+ characters).

Generate a suitable secret locally with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Add the value through the hosting provider's secret/environment settings. Do not put the generated value in this repository.

Configure Supabase Auth's Site URL and Redirect URLs for the exact staging application origin. Confirm the recovery email template redirects to the application with the recovery type and token fragment required by the callback handler. Test signup confirmation and password recovery with a dedicated non-production test account before inviting users.

## Verification added

- Encrypted session cookies do not contain the plaintext access or refresh token.
- Server-side user verification uses the access token; refresh rotates tokens and returns a replacement encrypted cookie.
- Invalid/tampered cookies fail closed.
- Password reset callback tokens are verified against Supabase before a session cookie is issued.
- Password changes use the authenticated server-side session.
- Invalid credentials return generic messages; email recovery does not disclose whether an account exists.
- Insecure remote Supabase URLs and short encryption secrets are rejected.

The new tests are included in the repository's existing `npm run verify:server` build gate. A green CI run and hosted tests are still required.

## Remaining release gates

This auth work does not complete the wider P0 release programme. Still required: a dedicated isolated Supabase project, reviewed RLS and private storage policies, active cloud asset API integration, durable multi-instance data/queue design, deployed worker, backup/restore rehearsal, monitoring, separate-role hosted acceptance and owner approval of recurring costs.

The Render Blueprint declares `SUPABASE_SESSION_SECRET` as an unsynchronized secret input. The branch is separate from the existing staging branch so this work does not trigger the current staging Blueprint.
