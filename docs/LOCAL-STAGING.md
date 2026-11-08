# Zero-cost isolated staging

Executive Visuals must not share the NEMA databases or any other existing Supabase project. The connected Supabase Free organization has already used its two active free-project slots. No paid upgrade, new hosted project, billing change, or production mutation is part of this plan.

## Staging topology

Use two zero-cost layers:

1. **Disposable CI integration environment.** GitHub Actions starts the official local Supabase stack in an isolated runner, applies every checked-in migration to a clean Postgres/Auth/Storage stack, checks the expected schema, row-level security and private media bucket, then destroys the stack. No Supabase account key or hosted project is used.
2. **Optional persistent developer environment.** Run the same Supabase stack locally with the Supabase CLI and Docker Desktop. The local Docker volumes persist between sessions and can be reset independently. This is the practical manual end-to-end environment for the cloud API and media worker without creating a hosted project.

This is a local/ephemeral staging substitute, not a public internet-accessible staging service. A public multi-user preview, always-on remote worker or hosted OAuth callback requires separately approved hosting; it is not silently substituted with an existing production service.

## CI verification

The `supabase-local-stack` job in `.github/workflows/ci.yml`:

- starts Supabase locally in the isolated GitHub runner;
- runs `supabase db reset --local`, applying all migrations from `supabase/migrations`;
- verifies the 14 application tables exist and have RLS enabled;
- verifies the private `executive-visuals-media` bucket and all four storage access policies;
- stops the local stack even when a preceding step fails.

The job uses only the runner's disposable Docker environment. It does not authenticate to the connected Supabase organization or access either existing project.

## Windows developer setup

The workstation has limited free space on C: and substantially more room on D:. Before installing Docker Desktop, free sufficient C: space for the installer and Windows/WSL requirements. In Docker Desktop settings, place the Docker disk image/data on D: (for example, `D:\\AI-Tooling\\DockerData`) so container layers and database volumes do not consume the constrained C: drive. Keep Docker Desktop's published ports bound to localhost.

From the repository root, after Docker Desktop is running:

```powershell
npx supabase@latest start
npx supabase@latest db reset
npx supabase@latest status
```

The local stack exposes its API on `http://127.0.0.1:54321`, Postgres on `127.0.0.1:54322`, and Studio on `http://127.0.0.1:54323`. The CLI prints local publishable/anon and service-role keys. Use only those local values for this environment:

- `AUTH_MODE=supabase`
- `SUPABASE_URL=http://127.0.0.1:54321`
- `SUPABASE_PUBLISHABLE_KEY=<local publishable key>`
- `SUPABASE_SERVICE_ROLE_KEY=<local service-role key>`
- `CLOUD_TIMELINE_API_ENABLED=true`
- `CLOUD_MEDIA_JOBS_API_ENABLED=true` only when deliberately testing the local worker and cloud media queue together.

Keep these values in an untracked local `.env` file. Never commit them, paste them into issues, or use production credentials. The service-role key is server-only. Start the API and worker in separate local terminals using the repository's existing scripts; keep the worker off until the local stack and database migrations are healthy.

To stop without deleting local database volumes:

```powershell
npx supabase@latest stop
```

To deliberately recreate the local database from migrations, `npx supabase@latest db reset` is destructive to that local stack's data. It does not affect any hosted project.

## Safety and acceptance limits

- Do not run `supabase link`, `supabase db push`, or `supabase projects create` as part of local setup.
- Do not use the NEMA staging or Chrishem Project credentials, schemas, storage buckets or database URLs.
- Do not expose local Supabase ports to the public internet or configure a public tunnel.
- Use synthetic test users and disposable media only.
- Local/CI verification can prove migration compatibility, RLS definitions, private bucket configuration, queue logic and worker behavior in a controlled environment. It does not prove hosted backups, production TLS/domains, external OAuth callbacks, public availability, hosted storage durability, or production worker uptime.
- Production signing remains disabled until the production KMS/HSM, certificate chain, timestamping and trust/revocation policy are separately provisioned and accepted.
