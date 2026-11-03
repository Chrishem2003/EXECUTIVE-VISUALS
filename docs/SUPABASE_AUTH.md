# Supabase authentication integration

This application uses a server-side Supabase Auth proxy. The browser never receives the publishable key from an API response and never stores the refresh token in JavaScript-accessible storage.

## Required staging configuration

Set these only on the isolated Executive Visuals staging service:

- `AUTH_MODE=supabase`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_AUTH_REDIRECT_URL=https://<staging-host>/`

The server uses the publishable key to call Supabase Auth. The service-role key is not required by this auth adapter and must never be exposed to the browser. Other cloud-storage/worker integrations have separate server-side service-role requirements and remain disabled until the dedicated project is approved.

In the Supabase Auth URL configuration, set the staging Site URL and add the exact callback URL above to the redirect allowlist. Do not add wildcard production domains. Configure email confirmation and password-recovery templates to route through Supabase's verification endpoint and return the verified recovery session to the configured application URL.

## Session model

1. Email/password sign-in and signup are proxied through the application API.
2. Supabase access tokens are held in browser memory only.
3. Refresh tokens are returned only as an HttpOnly, SameSite=Strict cookie scoped to `/api/auth`.
4. The browser calls `POST /api/auth/session` to rotate the refresh token after reload or an API 401. Concurrent refreshes in one tab share a single in-flight request.
5. Logout refreshes the current session if needed, revokes it with Supabase Auth and clears the cookie.
6. Password recovery sends an email. The recovery screen currently expects Supabase to redirect with `type=recovery` and `access_token` in the URL fragment. It removes the fragment from browser history and keeps the token in memory while the user sets a new password.
7. Authentication endpoints have per-email attempt budgets (sign-in: 8 per 15 minutes; signup: 5 per hour; recovery: 3 per hour), in addition to the per-source IP budget. Email keys are SHA-256 hashed before entering the in-memory limiter. The limiter prunes expired entries and caps its in-memory bucket count.

## Known limitations / acceptance blockers

- A Supabase PKCE callback that returns `?code=...` is not yet implemented. Confirm the configured email templates/auth flow returns the supported recovery fragment before enabling recovery in staging; otherwise add a PKCE verifier/exchange implementation first.
- CAPTCHA/Turnstile, distributed rate limiting across multiple API instances, and hosted email-delivery verification remain outstanding. The in-process per-email and per-source limiter is a single-instance baseline, not a substitute for edge/WAF controls.
- Email confirmation, recovery redirect allowlisting, refresh rotation across multiple tabs and logout revocation require browser-level acceptance tests against the dedicated staging project.
- This integration does not provision a Supabase project, change database schemas, or apply migrations.

## Local verification

The tests use a local mock identity provider and do not contact a real Supabase project:

- `node --test server/tests/supabase-auth.test.mjs`
- `node --test server/tests/supabase-auth-api.test.mjs`

The full repository build also runs the server test suite.
