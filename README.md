# CODEX 28 — DOTS VS BOTS

An original retro arcade VERSUS screen for the 28-day fan tracker: Tibo / Team Dots on the left, Lauren Tan / Team Bots on the right. Portraits, teams, records and source links come from the repository's existing public data. Improvements are hits; resets have separate totals. Community team votes power the health bars.

**Draft proposal only. Nothing merged or deployed.** The existing live Cloudflare approval poll is untouched. The proposed team poll uses **one Supabase backend**, with public-safe null configuration, and displays **COMING SOON** until configured. No account, database, credentials, billing or cloud security settings were created or changed.

Not affiliated with OpenAI or SpaceXAI. Fan-made tracker.

## Preview and verify

Node.js 22.16+, npm and Python 3 are required. The site is vanilla HTML/CSS/ES modules; there are no app dependencies or framework.

```sh
npm start
# http://127.0.0.1:4173/
npm run check
npm run test:versus-browser
```

The browser suite needs Python Playwright and its Chromium installed. It serves isolated loopback pages and intercepts all proposed backend calls; it never writes production votes. Desktop and 390px mobile screenshots go to `output/playwright/`. Tests cover source classification, PT midnight, spring/fall DST, exact vote/health arithmetic, storage, repeats/races, invalid input, rate limits, stale counts, lost responses and mobile/reduced-motion behavior.

`npm run build` validates both source files and copies an explicit public allowlist to `dist/`. It does not deploy anything. Backend SQL, old poll configuration, credentials, tests, screenshots and the legacy app are excluded. The committed static share image is generated from current data and original portraits; the build verifies its recorded data hashes and derives OG alt text from its metadata. To regenerate after a future owner data update:

```sh
npm run share:generate
npm run build
```

Static social crawlers cannot execute the runtime JSON fetch. Regenerate the share artifact when source data changes, then review any later publication separately.

## Source rules and current uncertainty

The requested all-in-one JSON schema is not present. `data.json` holds Tibo day records; `versus.json` holds the top-level teams and numbered Grok lists. The read-only adapter requires their calendars to match. Both files are preserved. See [counting rules](docs/versus-rules.md) and [full repository audit](docs/repository-audit.md).

Current Tibo data has **3 explicit improvement records / hits** and **2 explicit resets**. Numbered features inside prose do not establish separate typed records, and resets never count as hits. Grok's **11 entries lack type/status**: its hit/reset totals are unknown (0 confirmed each), and current populated round winners are unresolved. Empty rounds show NO MOVE; pending stays pending. A final KO after round 28 requires complete classified data and uses greater total confirmed hits; ties draw. No winner is invented.

The source labels the second fighter **Lauren Tan**, so this draft preserves that spelling. The October 5–November 1 window is this project's counting convention, not a verified official schedule. The countdown uses America/Los_Angeles and respects the 25-hour final DST day.

`data.json` SHA-256 before/after:

```
d3afceec07918f307e4e391afa8e5b2d1c7f862ba50c3221e14ac6702578a926
```

At audited heads `main` 6096c53 and `gh-pages` 73b6bcb, data bytes and every shared public file match. The branch differences are 18 source-only docs/backend/tests/tooling files. This task does not write either branch or reconcile anything.

## Proposed poll setup

Read [supabase/README.md](supabase/README.md) for the complete manual setup checklist and [proposed SQL](supabase/proposal.sql). Supabase is chosen because one append-only votes table, an atomic RPC and its unique key can enforce one immutable row per authenticated anonymous device identity per **server-computed PT day**, with no client-writable counters. Anonymous Auth supplies the JWT identity; a saved device hint plus Web Locks handles ordinary repeat clicks and tabs. Only server-confirmed counts are shown.

Configuration belongs only in `versus-config.json`:

```json
{"supabaseUrl": null, "publishableKey": null}
```

A future approved setup would use a separate free-tier project, review the proposed SQL/RLS/grants locally, enable anonymous sign-ins with provider IP limits and CAPTCHA, then insert its HTTPS URL and **publishable** key. Never put a secret or service-role key in the frontend. Those setup/deployment actions have **not** been performed by this draft.

This is a device/browser poll, not one verified person. Clearing storage or using another device can allow another identity. Atomic uniqueness guards each identity/day; Supabase Auth rate limits anonymous signup by IP. Auth CAPTCHA is recommended for stronger abuse resistance, but requires a token UI integration before enabling it; the draft client fails closed if the provider requires a missing token. The RPC itself does not claim a per-IP ballot guarantee. See backend docs for limits and the remaining abuse risk.

Counts refresh every 15 seconds while visible and on returning to the tab. Errors retain labeled last-loaded counts, block speculative switching and offer reconciliation/retry. New votes leave white damage trails and a short shake; synthetic hit audio starts muted and needs a gesture to enable. Reduced motion removes movement and flashing. Health follows the exact requested opponent-vote formula and bottoms out at 10%, so the strict `<10` flashing threshold is unreachable with valid votes.

## Keep the live approval poll separate

`backend/`, `app.js`, `polls.js`, `styles.css`, `voting-config.json` and their tests remain unchanged. The original entry page is preserved at [legacy/index.html](legacy/index.html), with its old documentation in [legacy/README.md](legacy/README.md). This local compatibility page can contact the existing Worker if opened. The new page/build never loads it or that configuration.

Do not convert approve/not_convinced votes into Dots/Bots votes: they answer different questions. Preserve the current Cloudflare database/history. Any later transition should review a new frontend publication independently, retain old resources, and provide an intentional archive path if desired. This draft does not migrate records, retire resources, deploy security rules, merge, publish or change Pages settings. [DEPLOYMENT.md](DEPLOYMENT.md) describes the **historical live release**, not authorization to deploy this draft. The historical `test:voting-browser` targets that prior UI; use `test:versus-browser` for this redesign.

## Design and licenses

Original pixel borders, nameplates and cabinet-style layout evoke the genre without using Street Fighter, Sega or Tekken artwork/logos. Press Start 2P is bundled unchanged from Google Fonts and distributed under SIL Open Font License 1.1; see [assets/FONT-LICENSE.txt](assets/FONT-LICENSE.txt). Sans-serif body copy keeps longer source summaries readable. Code is [MIT](LICENSE). Existing dot artwork provenance remains in [assets/LICENSE.txt](assets/LICENSE.txt). Existing portrait files are retained unchanged; this draft does not assert new rights to them. The static share image includes those supplied portraits for this fan tracker.
