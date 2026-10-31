# Development

## Requirements
- Node.js 20.19+ or 22.12+
- npm

## Run locally
```bash
npm install
npm run dev
```
Open the URL printed by Vite (normally http://localhost:5173).

## Validate
```bash
npm run typecheck
npm run build
```

## Current local capabilities
- Switch between production workspaces.
- Create and persist creative briefs in browser local storage.
- Create shot/production jobs with explicit capability and provider status.
- Add reference files to a local asset shelf for the current browser session.
- Filter the project/job library and inspect job details.
- Provider readiness is explicitly marked as unconfigured until a real adapter exists.

The current browser-only foundation does not upload files to a server or generate media. Uploaded file previews are held in memory and disappear on refresh; project and job metadata persist locally. A future storage adapter will replace this development behavior.

## Security
Keep provider credentials on a trusted server. Do not expose secrets in frontend environment variables, local storage, source control, URLs, or logs. Use only media and likenesses for which you have appropriate rights and consent.
