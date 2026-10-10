# VERSUS draft verification

- `npm run check`: syntax, all **167 Node tests**, strict two-source validation and the explicit **22-file static build** pass.
- VERSUS Python Playwright: **25 browser checks** pass; [machine-readable report](browser-qa.json).
- `npm run test:voting-browser`: **14 original-UI browser regression checks** pass against the real local SQLite Worker adapter; [report](legacy-browser-qa.json). The wrapper serves the preserved legacy page only in its isolated fixture. Its stale day-5 expectation now checks the owner's actual reported future entry has no poll, without changing data or app behavior.
- Viewports 320, 390, 768, 1440: no horizontal overflow. Main native controls are at least 44px high. Keyboard Enter/Space, visible focus, touch buttons, muted-default sound and reduced-motion behavior checked.
- Source-backed counters/classification, separate hits/resets, source fetch failure/retry, Pacific midnight rollover, 25-hour final DST day and data-based/no-invented KO states checked.
- Local intercepted Worker team/approval mocks: exact vote health, the existing saved UUID, independent per-update choices, one daily team choice, duplicate/race original-choice response, committed and uncommitted lost responses, retry/reconciliation, PT rollover, 429, storage failure and read recovery checked.
- Actual team SQL runs in real local SQLite transactions. Six independent connections make 168 racing requests: exactly 121 unique votes accepted, 47 duplicates keep the original choice, 121 total votes persist after restart. Additive migration/votes preserve seeded approval rows, schema and results. Strict source validation, bounds/CORS, immutability, rollback and optional rate-binding failures are covered; existing 80 legacy/model/poll tests pass.
- No page exceptions, live Worker requests or unexpected external requests during VERSUS QA. Screenshots use real source files/config with clock fixed at `2026-10-11T01:00:00Z` (October 10 PT, round 6), an unconfigured COMING SOON team match, and approval calls intercepted with 503. No shared counts are fabricated. Mock fixtures never overwrite source files.
- Independent review found and fixed the Bots green health tone, stale-count date labeling, and a fresh-tab identity initialization race. Both new controllers initialize the existing UUID under the same Web Lock; a deterministic test proves one identity. No outstanding P1/P2 findings.
- Share export: 1200×630, both existing portraits, bundled font, generated counters/alt text, embedded source hashes, no external requests. [Share image](../assets/versus-share.png), [metadata](../assets/versus-share-metadata.json).

## Screenshots

[Desktop, 1440×4647](screenshots/desktop.png) and [mobile, 390×6743](screenshots/mobile-390.png) were visually reviewed. They include original per-update approval controls, source-derived roles and Lauren Tan's correct name/avatar. They are review evidence, excluded from the public build.

## Preservation

`data.json` before/after and `dist/data.json` all have SHA-256:

```
d3afceec07918f307e4e391afa8e5b2d1c7f862ba50c3221e14ac6702578a926
```

`versus.json` before/after and in the build has SHA-256 `c8450709344a0a9209203a054234df1bab22aac26e65b141708ff1a1bd2f2e6a`.

Both data files, existing avatars, `model.js`, legacy CSS/JS/client/config, migration 0001 and original Node tests are unchanged. The Worker adds three lines for a separate team-route dispatch; its approval handler remains compatible. `main` and `gh-pages` data bytes match; only source-only files differ between audited branches. Latest remote heads were unchanged before the correction. Neither branch was written.

## Practical limits

The existing Worker/D1 supports the new choices through isolated routes and additive storage; no replacement backend remains in the PR. Local SQLite tests and intercepted browser requests do not establish deployed Cloudflare runtime behavior, capacity or a live team feature. The setup checklist requires separate authorization and isolated runtime verification before a cloud change or publication.

Optional provider device/IP rate-limiting code is mocked and remains unconfigured. Its limits are approximate per Cloudflare location; UUIDs do not establish one verified person. Both sides are counted per listed update: `versus.json` `days[].tibo` (11 items from `data.json`'s numbered summaries) and `days[].grokbot` (11 labelled items); resets are shown separately and never count as hits. No cloud changes, live migration, production test votes, merge or deploy occurred.

## Library delivery

The prepared helper was unavailable before any write. The current Library skill explicitly permits direct owned-file actions when prepared tools are unavailable. All three PNGs were saved, then the corrected desktop/mobile screenshots replaced those same Library items with an expected-version guard. Every write returned `succeeded`; identity metadata was applied locally. The share image was regenerated and remained byte-identical, so its saved version is still current. No denied action was bypassed.

| File | Verified Library file ID | Version |
| --- | --- | --- |
| `versus-desktop.png` | `libfile_2fc88f22f65c819189eb0eb53f5ed93a` | 1 |
| `versus-mobile-390.png` | `libfile_d2bf73f9ac5481919b66aaf91c8aa382` | 1 |
| `versus-share.png` | `libfile_8ddd2a50b9388191bf53128b182f1729` | 0 |
