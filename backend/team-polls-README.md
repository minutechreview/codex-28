# Team voting extension — code review only

This extension reuses the existing `codex-28-voting` Cloudflare Worker and its dedicated D1 binding. The existing backend can support two team choices, so no Firebase, Supabase, new account or replacement database is needed. Nothing in this draft deploys a Worker, applies a remote migration, enables a binding, changes billing or writes live votes.

The existing `/polls/:id` approval API, `polls` / `votes` tables, migration 0001, `model.js` strict validation and `voting-config.json` remain compatible. The new Worker dispatches only `/teams/` to `team-polls.js`. Migration 0002 adds `team_polls`, `team_votes` and their own triggers; it never converts approval history into team preferences. Tibo's original approval controls remain in the redesigned round log.

## Request and storage contract

| Request | Contract |
| --- | --- |
| `GET /teams/YYYY-MM-DD?voterId=UUIDv4` | Read today's counts and this saved browser's choice. Omit `voterId` for public counts only. |
| `POST /teams/YYYY-MM-DD` | Exactly `{"voterId":"UUIDv4","choice":"dots"}` or `"bots"`, JSON, from the allowed site origin. |
| Result | `{day, open, dotsVotes, botsVotes, totalVotes, yourVote}`; POST adds `accepted`. |

The server captures one request timestamp and computes its date in `America/Los_Angeles`. Requests for a different day return 410; writes outside the unchanged 28-day tracker window are closed. Current-day reads outside the window report `open:false`. Every request checks the unchanged published `data.json` through the original strict validator to establish the calendar. It does not require a Tibo update to open the separate team match, or inspect prose to classify Grok records.

The server hashes the saved UUID, binds SQL values, and uses a D1 `batch()` transaction for day creation, conflict-safe vote insertion, and result read. `(poll_date, voter_hash)` is the primary key. Insert triggers increment only the chosen team by one. Duplicate/racing requests retain exactly one original choice and return `accepted:false`; counters never come from the browser. Team UPDATE is blocked by an immutable-row trigger, and there is no visitor update/delete API. Authorized database maintenance retains a decrement trigger to keep counts consistent. Primary sessions avoid stale reads if replication is later enabled. [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/).

The frontend uses the existing saved browser UUID and separate per-day original-choice hints, with Web Locks for ordinary cross-tab team operations. It never invents shared counts. Lost responses reconcile the original choice before permitting a retry. Blocking storage/locks disables team voting. Clearing storage, another browser/device or deliberate UUID generation can allow additional votes: this is **one saved device identity per Pacific day**, not one person or authenticated account. Browser Origin checks and hashed UUIDs do not authenticate visitors.

## Optional abuse guard

When an operator supplies a reviewed `TEAM_VOTE_RATE_LIMITER` binding, the new route checks hashed device and trusted Cloudflare `CF-Connecting-IP` keys before writes. Denial returns 429; binding failure returns 503. The binding is **not configured by this draft** and no live IP limits are claimed. Cloudflare's binding limits are approximate and apply per Cloudflare location, rather than a global per-person guarantee. Do not rely on them as an authentication or exact ballot guard. [Workers rate-limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Without that optional binding the exact per-identity/day database guard still applies, along with bounded JSON/source streams, strict inputs and source checks. Scripts can generate multiple UUIDs. Future abuse settings must be reviewed against the existing Free plan and current configuration; no paid feature, CAPTCHA integration or new cloud setting is authorized here.

## Local verification and later operator checklist

```sh
npm run check
node --test tests/backend.test.js tests/team-backend.test.js
VOTING_DEV_DB=/tmp/codex-28-team-local.sqlite VOTING_DEV_NOW=2026-10-10T20:00:00Z npm run voting:dev
```

The loopback dev server applies both migrations only to its local SQLite fixture. The new tests use the actual SQL with independent SQLite connections/transactions, not simulated counters. They cover legacy coexistence, strict data/source rejection, malformed/oversized input, CORS, PT midnight/DST, immutable choices, duplicates/concurrency, rollback, rate-binding mocks and failure recovery. Browser QA intercepts both team and approval calls; it never submits production votes. SQLite and mocks establish local contracts, not a deployed Cloudflare runtime or capacity result.

Before any later authorized cloud change:

1. Inspect the existing dedicated Worker settings, D1 tables and migration history. Preserve them; do not create or repurpose another database. Check that the new table/trigger names are unused.
2. Review migration 0002 and test the extended Worker against an isolated local fixture. Confirm `/polls/...` counts/history remain unchanged when team votes are added. Keep migration 0001 and strict `data.json` validation intact.
3. Obtain separate release authorization before applying migration 0002 or deploying the extended Worker. Keep old routes operational; never reset the database or seed live test votes.
4. Review any optional rate binding separately using the current installed Wrangler help/schema and existing Free-plan capabilities. The example Worker config is intentionally unchanged.
5. Only after isolated runtime verification, set `versus-config.json` to `{"apiBaseUrl":"https://codex-28-voting.ryanatcdr.workers.dev"}`. Keep the original `voting-config.json` as-is. Until then the new team match says **COMING SOON** and sends no `/teams/` requests.
6. Review frontend publication separately. This draft PR must not be merged or deployed.
