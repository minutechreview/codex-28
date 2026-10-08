# Shared daily voting backend — prepared, not provisioned

The static GitHub Pages site needs a server and database for shared visitor counts. This implementation is a Cloudflare Worker with one D1 database. No Worker, D1 database, credential, account grant, paid plan, DNS change, or deployment was created by this preparation. `wrangler.example.jsonc` deliberately contains an unusable database ID. Keep the public voting configuration disabled until an authorized backend is configured and verified.

The exact production website origin is `https://minutechreview.github.io`. The Worker reads and validates `https://minutechreview.github.io/codex-28/data.json` on every request with caching disabled and a five-second timeout. The production export never takes a source URL or origin from environment bindings or visitor input. Only a published, non-pending update whose date has arrived in `America/Los_Angeles` is eligible, including a reported `missed` outcome. Invalid or unavailable published data blocks reads and writes with a retryable error. Updating a day's summary or status preserves its poll ID and previous votes. Starting a new day preserves earlier polls. A temporarily reverted pending update hides voting while keeping its stored history.

## API contract

Poll IDs are `codex-28:YYYY-MM-DD:day-N`, with the day/date matching the fixed October 5–November 1, 2026 window. Encode the poll ID as a URL path component.

- `GET /polls/:id?voterId=UUIDv4` returns `{ pollId, approve, notConvinced, total, yourVote }`. Omitting `voterId` returns public totals with `yourVote: null`.
- `POST /polls/:id` accepts exactly `{ "voterId": "UUIDv4", "choice": "approve" | "not_convinced" }` as JSON. It returns the same result plus `accepted: true` for a new vote, or `accepted: false` and the original choice for an idempotent repeat. A changed choice cannot replace a recorded vote.
- Errors return `{ "error": { "code": "...", "message": "..." } }`. Validation errors use 400/413/415, disallowed origins use 403, unavailable polls use 404, unsupported methods use 405, and temporary source/database failures use 503.

The browser generates a random UUID and saves it for repeat prevention. The database stores a SHA-256 hash of that UUID, its day-specific choice, and submission time. The UUID is a pseudonymous browser identifier, not an account or proof of a unique person. Clearing browser storage, switching browsers, or deliberately generating new IDs can permit additional votes. Origin checks protect normal browser integrations; they do not authenticate people or stop a script that supplies its own Origin header. There is no IP fingerprinting, visitor update-editing permission, administration endpoint, or account credential in the frontend. Request/body/source size limits bound individual requests; stronger bot or rate controls would require a separately reviewed service configuration. No private request logging or analytics is enabled by the example Worker configuration.

The `votes` primary key `(poll_id, voter_hash)` enforces one recorded vote for each browser ID per day. SQLite insert triggers atomically maintain counters. The poll creation, conflict-safe insertion, and final results query run in one D1 `batch()` transaction. Repeat retries therefore never increment counts, including when a first request committed but its response was lost. Prepared statements bind all visitor values. Counts use indexed poll rows rather than scanning every historical vote. Primary reads avoid stale counts if D1 read replication is enabled later.

Cloudflare documents [transactional D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 binding result objects](https://developers.cloudflare.com/d1/worker-api/return-object/), and [Workers configuration](https://developers.cloudflare.com/workers/wrangler/configuration/). SQLite tests verify the same SQL; a Cloudflare deployment smoke test is still required before release.

## Local verification

Node 22.16 or newer with built-in `node:sqlite` runs this without installing dependencies (verified with Node 22.22.3):

```sh
node --test tests/backend.test.js
VOTING_DEV_DB=/tmp/codex-28-local-votes.sqlite VOTING_DEV_NOW=2026-10-08T20:09:00Z node scripts/voting-dev-server.js
```

The API binds only `127.0.0.1:8787`. It reads local `data.json` for each request and allows only loopback site origins on ports 4173–4176. Override the local port, source fixture, or database file with `VOTING_DEV_PORT`, `VOTING_DEV_SOURCE`, or `VOTING_DEV_DB`. The QA wrapper aliases `VOTING_PORT`, `VOTING_DATA_PATH`, and `VOTING_DB_PATH` are also supported. `VOTING_DEV_NOW` is only a local test clock. The production Worker uses the real clock and published JSON. Put test databases and modified fixtures outside the public build. The adapter in `tests/helpers/sqlite-d1.js` models the D1 interface using real SQLite transactions and is never shipped to browsers.

Tests cover invalid/repeated/concurrent submissions, bounded streaming bodies, exact CORS, unknown/pending/future polls, Pacific midnight and daylight saving boundaries, malformed/unavailable published data, database failures, SQL constraints and rollback, same-day edits, independent day history, and database close/reopen. The concurrency test starts six threads with independent SQLite database connections and verifies 168 attempts produce exactly 121 unique recorded votes.

## Activation after the required approval

First identify an existing authorized Cloudflare account and suitable database/Worker permissions, and inspect its current plan and settings. If a new account, login grant, credential, database, Worker resource, paid usage, changed security setting, or acceptance of terms is required, obtain the user's explicit approval for those exact actions before proceeding. Do not repurpose an unrelated database or deployment.

After approval, an operator can copy `backend/wrangler.example.jsonc` to a private local Wrangler configuration, replace the database placeholder with the approved existing/created D1 database ID, and apply `backend/migrations/0001_daily_polls.sql` through the approved D1 migration mechanism. Review the migration against the target database first; it creates only this feature's `polls`/`votes` tables and related triggers. Existing counts must stay intact on redeployment; never delete/recreate the database for an ordinary site or data update.

Deploy the Worker using the approved account and existing authorized tooling, then verify CORS, live-source validation, database binding/migration, retry idempotency, and independent-browser shared counts against that actual endpoint. Use a controlled non-public test deployment/database for test submissions so live visitor counts are not polluted. Configure the reviewed HTTPS endpoint in the public frontend configuration, run the full static checks, and publish source and `gh-pages` separately following `../DEPLOYMENT.md`. The GitHub Pages site URL stays unchanged. Backend code, database IDs/configuration, tests, local databases, and private credentials do not belong in the Pages payload.
