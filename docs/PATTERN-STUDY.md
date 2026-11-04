# Pattern study: AI video and image creation tools

This is a study of common product patterns across the category, drawn from public information. It names no products. Each pattern is mapped to what Executive Visuals now does, and to what is still open.

## 1. Camera and look presets

**Pattern.** Creators rarely write camera language from scratch. They pick from a visual library (dolly, orbit, crane, handheld, macro, golden hour) and the tool turns the pick into prompt text.

**Here.** `src/core/presets.ts` holds an original, frozen library of camera moves, framings, light setups and looks. Presets fill the existing shot fields (movement, camera, lens, lighting) and respect the server's field limits. `composePrompt` orders, dedupes and trims fragments for a free-form prompt. The library shows in the Cinema view (apply to a shot) and the Image view (add to prompt).

**Open.** Preview thumbnails per preset, and user-saved custom presets.

## 2. Model menu with tiers

**Pattern.** Users choose between fast/cheap drafts and slow/premium finals, and the menu shows what each costs.

**Here.** `server/model-catalog.mjs` reads an operator-defined menu from `MODEL_CATALOG_JSON`, joins it to live gateway status, and reports each model as connected, listed, gateway off, or needs setup. A model counts as connected only when the gateway's configured model is exactly that one. Provider model ids never reach the browser. Endpoints: `GET /api/models` and `POST /api/models/estimate`.

**Open.** Routing a request to the chosen model per call (gateways still read one env model each).

## 3. Draft first, finalize later

**Pattern.** Explore many cheap takes, then spend on the few keepers.

**Here.** The estimator has a plan mode that compares drafts plus finals against exploring everything at the final tier, and shows the saving.

## 4. Cost awareness before spending

**Pattern.** Credits and per-job costs are shown up front.

**Here.** Estimates use operator-supplied prices and carry a disclaimer that the provider's bill is the source of truth. `REMOTE_DAILY_COST_LIMIT_USD` is shown as a ceiling and flagged when a request exceeds it.

**Open.** Enforcing the cap, per-account spend tracking, and a credits ledger. Not part of this wave, and nothing here fakes generation or billing.

## 5. Next candidates

- A real generation form on the Image view (it is still a stub).
- Reference-frame (first frame) input for video models that support it; the catalog already records `supportsFirstFrame`.
- Persistent storage so work survives host restarts.
- Admin panel for the model menu and spend.
