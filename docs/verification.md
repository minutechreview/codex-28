# VERSUS draft verification

- `npm run check`: syntax, all **142 Node tests**, two-source validation and the explicit **19-file static build** pass.
- Python Playwright: **19 browser checks** pass; [machine-readable report](browser-qa.json).
- Viewports 320, 390, 768, 1440: no horizontal overflow. Main native controls are at least 44px high. Keyboard Enter/Space, visible focus, touch buttons, muted-default sound and reduced-motion behavior checked.
- Source-backed counters/classification, separate hits/resets, source fetch failure/retry, Pacific midnight rollover, 25-hour final DST day and data-based/no-invented KO states checked.
- Local intercepted Supabase mocks: exact vote health, saved anonymous session, one daily choice, duplicate/race original-choice response, committed and uncommitted lost responses, retry/reconciliation, server day rollover, 429, persistent-storage failure and read recovery checked.
- No page exceptions, live Worker requests or unexpected external requests during browser QA. Screenshots use real source files with clock fixed at `2026-10-11T01:00:00Z` (October 10 PT, round 6) and unconfigured COMING SOON poll. Mock fixtures are confined to tests and never overwrite source data.
- Independent review found and fixed the Bots green health tone and explicit date labeling of stale cached results across midnight. No outstanding P1/P2 findings.
- Share export: 1200×630, both existing portraits, bundled font, generated counters/alt text, embedded source hashes, no external requests. [Share image](../assets/versus-share.png), [metadata](../assets/versus-share-metadata.json).

## Screenshots

[Desktop, 1440×4010](screenshots/desktop.png) and [mobile, 390×5707](screenshots/mobile-390.png) were visually reviewed. They are review evidence, excluded from the public build.

## Preservation

`data.json` before/after and `dist/data.json` all have SHA-256:

```
d3afceec07918f307e4e391afa8e5b2d1c7f862ba50c3221e14ac6702578a926
```

`data.json`, `versus.json`, existing avatars, legacy CSS/JS/config, Worker/D1 source and their tests are unchanged. `main` and `gh-pages` data bytes match; only source-only files differ between audited branches. Neither branch was written.

## Practical limits

The proposed actual Supabase SQL/RLS and security advisors have **not been executed**. Local PostgreSQL and Supabase CLI are absent. Tests use real SQLite uniqueness plus mocked Auth/RLS/RPC contracts, not a PostgreSQL emulator; they do not establish deployed provider behavior or load capacity. The future manual setup instructions explicitly require real local role/advisor/concurrency checks before deployment.

Provider signup IP rate limits are documented, not configured or live-tested. CAPTCHA would require a separately reviewed token integration. Anonymous device identities do not establish one verified person. Grok's 11 untyped entries prevent verified hit/reset totals and winners. No cloud changes, production test votes, merge or deploy occurred.

## Library delivery

The current required prepared batch helper failed before any preparation/upload with `Library prepare_uploads is not available`, after an approved network retry resolved the initial sandbox DNS failure. No files were saved and no Library IDs were returned. The current Library skill requires the batch helper and prohibits replacing a required prepared flow with direct uploads; no alternate write or unknown-outcome retry was attempted. All three reviewed PNGs remain intact in this branch/local workspace.
