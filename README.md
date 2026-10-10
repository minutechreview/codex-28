# CODEX 28 — DOTS VS BOTS

An original retro arcade VERSUS screen for the 28-day fan tracker: Tibo / Team Dots on the left, Lauren Tan (@poteto, she/her) / Team Bots on the right. Portraits, teams, records and source links come from the repository's existing public data. Improvements are hits; resets have separate totals. Community team votes power the health bars; Tibo's existing per-update approval polls remain available in the round log.

**Draft code only. Nothing merged or deployed.** Team voting reuses the existing Cloudflare Worker/D1 through separate routes and additive tables. Existing approval routes, storage and public configuration are preserved. The new team configuration is `null`, so that poll displays **COMING SOON** until the extension is separately authorized, deployed and configured. No new provider, account, database, credentials, billing or cloud settings were created or changed.

Not affiliated with OpenAI or SpaceXAI. Fan-made tracker.

## Preview and verify

Node.js 22.16+, npm and Python 3 are required. The site is vanilla HTML/CSS/ES modules; there are no app dependencies or framework.

```sh
npm start
# http://127.0.0.1:4173/
npm run check
npm run test:versus-browser
```

The browser suite needs Python Playwright and its Chromium installed. It serves isolated loopback pages and intercepts all Worker calls; it never writes production votes. Desktop and 390px mobile screenshots go to `output/playwright/`. Tests cover source classification, PT midnight, spring/fall DST, exact vote/health arithmetic, storage, repeats/races, invalid input, rate limits, stale counts, lost responses, per-update polls and mobile/reduced-motion behavior. `npm run test:voting-browser` also checks the retained original UI through its local compatibility page.

`npm run build` validates both source files and copies an explicit public allowlist to `dist/`. It does not deploy anything. The unchanged per-update client and public `voting-config.json` are included; backend SQL, credentials, tests, screenshots and the legacy app are excluded. The committed static share image is generated from current data and original portraits; the build verifies its recorded data hashes and derives OG alt text from its metadata. To regenerate after a future owner data update:

```sh
npm run share:generate
npm run build
```

Static social crawlers cannot execute the runtime JSON fetch. Regenerate the share artifact when source data changes, then review any later publication separately.

## Source rules and current uncertainty

`data.json` holds Tibo day records (unchanged; the live Worker validates it strictly); `versus.json` holds the top-level teams plus aligned per-day numbered update lists for both sides: `days[].tibo` (taken from the numbered items already in `data.json`'s summaries) and `days[].grokbot`. The read-only adapter loads both and requires their calendars to match. Both actual files and their strict schemas are preserved; unknown fields are rejected. See [counting rules](docs/versus-rules.md) and [full repository audit](docs/repository-audit.md).

Both sides are counted the same way: **every listed shipped update is one hit**, shown per day from Day 1. Usage resets come from `data.json`'s day status, show on their day as a USAGE RESET card and have their own counter, but never count as hits and never zero out that day's launches. Current totals: **Tibo 11 hits / 2 resets, Grok Bot 11 hits / 0 resets.** Each round goes to the side with more improvements that day; equal counts draw; a day where either side is still pending is UNRESOLVED. A final KO after round 28 uses greater total hits; ties draw. No winner is invented.

The second fighter is **Lauren Tan (@poteto, she/her)**, using `assets/poteto.jpg` on the right. Tibo uses `assets/tibo.jpg` on the left. The October 5–November 1 window is this project's counting convention, not a verified official schedule. The countdown uses America/Los_Angeles and respects the 25-hour final DST day.

`data.json` SHA-256 before/after:

```
d3afceec07918f307e4e391afa8e5b2d1c7f862ba50c3221e14ac6702578a926
```

At audited heads `main` 6096c53 and `gh-pages` 73b6bcb, data bytes and every shared public file match. The branch differences are 18 source-only docs/backend/tests/tooling files. This task does not write either branch or reconcile anything.

## Team poll extension and setup

Read [backend/team-polls-README.md](backend/team-polls-README.md) for the extension contract and manual setup checklist. The existing Worker/D1 can support two-team voting: separate `/teams/YYYY-MM-DD` routes and `team_polls` / `team_votes` tables reuse its transactional batch, primary reads, bound SQL and saved browser identity. `/polls/...`, its `polls` / `votes` tables, migration 0001 and `model.js` remain compatible. The additive migration does not convert or overwrite approval history. No Firebase or Supabase replacement is needed.

Configuration belongs only in `versus-config.json`:

```json
{"apiBaseUrl": null}
```

A future separately approved setup would inspect the existing dedicated D1 migration history and Worker settings, review/apply only the additive team migration, test the extended Worker in isolation, then set this URL to the same reviewed public Worker endpoint. Preserve `voting-config.json`. No account or browser credential is needed. None of those cloud or publication steps was performed by this draft.

This is one saved browser/device identity per PT day, not one verified person. Clearing storage or using another device can allow another identity. Atomic D1 uniqueness prevents repeated accepted votes for the same identity/day; Web Locks and saved original-choice hints handle ordinary tabs and ambiguous retries. Any provider rate-limiting binding is optional proposed configuration, not enabled or evidence of global per-IP enforcement. See backend docs for the tested limits and remaining abuse risk.

Counts refresh every 15 seconds while visible and on returning to the tab. Errors retain labeled last-loaded counts, block speculative switching and offer reconciliation/retry. New votes leave white damage trails and a short shake; synthetic hit audio starts muted and needs a gesture to enable. Reduced motion removes movement and flashing. Health follows the exact requested opponent-vote formula and bottoms out at 10%, so the strict `<10` flashing threshold is unreachable with valid votes.

## Preserve the live approval poll

`app.js`, `polls.js`, `styles.css`, `voting-config.json`, `model.js`, migration 0001 and their existing tests remain unchanged. The Worker adds only a separate route dispatch; the approval handler retains its original behavior. The round log reuses the existing client/config for each eligible Tibo update. The original entry page is also preserved at [legacy/index.html](legacy/index.html), with its old documentation in [legacy/README.md](legacy/README.md). Both UIs can contact the configured existing approval endpoint when opened; browser QA intercepts those requests.

Do not convert approve/not_convinced votes into Dots/Bots votes: they answer different questions. Preserve the current Cloudflare database/history. Any later release must review the additive extension and frontend publication independently. This draft does not migrate live records, retire resources, deploy, merge, publish or change Pages settings. [DEPLOYMENT.md](DEPLOYMENT.md) describes the **historical live release**, not authorization to deploy this draft.

## Design and licenses

Original pixel borders, nameplates and cabinet-style layout evoke the genre without using Street Fighter, Sega or Tekken artwork/logos. Press Start 2P is bundled unchanged from Google Fonts and distributed under SIL Open Font License 1.1; see [assets/FONT-LICENSE.txt](assets/FONT-LICENSE.txt). Sans-serif body copy keeps longer source summaries readable. Code is [MIT](LICENSE). Existing dot artwork provenance remains in [assets/LICENSE.txt](assets/LICENSE.txt). Existing portrait files are retained unchanged; this draft does not assert new rights to them. The static share image includes those supplied portraits for this fan tracker.
