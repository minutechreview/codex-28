# Proposed TEAM DOTS / TEAM BOTS poll

This is preparation for a future operator setup. No Supabase account, project, database, rule, credential, billing setting, or deployment was created or changed. `proposal.sql` is a reviewable SQL proposal, not an applied migration. The shipped `versus-config.json` contains only `null` placeholders; the page shows **COMING SOON** and makes no poll-provider requests until configured.

Supabase is the one proposed provider. A single append-only vote table plus a transactional Postgres RPC makes concurrent submissions straightforward, while anonymous Auth supplies a server-verified identity without asking for personal details. The vanilla browser uses `fetch`; there is no Supabase dependency or secret in the static build. Supabase currently includes anonymous sign-ins on its $0 Free plan, with 50,000 monthly active users and a 500 MB database. Free projects can pause after a week of inactivity; quota/service failures are shown as unavailable, never successful votes. Check current limits before any future setup. [Supabase pricing](https://supabase.com/pricing).

## Keep the existing live backend separate

The existing `backend/`, `polls.js`, `voting-config.json`, approval-poll tests, and local voting scripts remain intact. Their Cloudflare Worker/D1 endpoint and stored `approve` / `not_convinced` history are independent. The new UI imports `versus-poll.js` and reads `versus-config.json`; it does not call the old Worker. Do not convert approval-poll records into team votes: they answered a different question. No Cloudflare migration, teardown, redeployment, or history import is part of this proposal.

For a future authorized cutover, retain the old resources and configuration, test the new provider against a separate local/staging fixture, review the static config change, and publish the site only through the existing release process. The current PR prepares that change but neither merges nor deploys it. A rollback can restore the previous site while retaining both providers' histories.

## Storage and atomic guard

The only application table is `versus_private.votes`. The private schema must stay outside the Data API's exposed schemas. Each row contains a server-derived Pacific `vote_day`, authenticated `voter_id`, team, and server submission time. `(vote_day, voter_id)` is the primary key. An INSERT adds exactly one row; `ON CONFLICT DO NOTHING` preserves the original choice for duplicate, retry, or racing requests. Counters are aggregates of rows, so there is no visitor-supplied increment or counter update.

`cast_versus_vote` is **SECURITY INVOKER**. RLS requires `voter_id = auth.uid()` and the current server day. INSERT grants permit only `voter_id` and `team`; day/time are defaults. There are no UPDATE/DELETE grants or policies. The RPC accepts a team and an expected day; it rejects stale, future, or historical days rather than treating the browser clock as authority. The active October 5–November 1, 2026 window is copied from the unchanged tracker data. A future tracker window requires a separately reviewed backend change.

Shared totals intentionally need to cross own-row RLS. The private, argument-free `versus_private.results()` function is the one **SECURITY DEFINER** exception: it checks `auth.uid()`, fixes `search_path = ''`, fully qualifies table/function references, and returns only today's aggregate counts plus the caller's own choice. It accepts no date, identity, or query fragment. PUBLIC/anon execution is revoked; only authenticated users get explicit execute grants through the public SECURITY INVOKER wrappers. It is VOLATILE so reads after an insert/conflict see the fresh transaction state. Never broaden it to return vote rows. Supabase recommends invoker functions and narrow, explicit definer privileges. [Database function security](https://supabase.com/docs/guides/database/functions).

Anonymous sign-ins use the `authenticated` Postgres role. API keys identify the public app; only the user access JWT supplies `auth.uid()`. Authorization does not trust editable user metadata. [Anonymous Auth](https://supabase.com/docs/guides/auth/auth-anonymous), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

The browser retains an anonymous session and per-day pending/confirmed choice hints in localStorage. It never stores authoritative counts. Web Locks serialize session creation, token refresh, and choice submission across tabs. Storage or locks unavailable means voting is disabled. A lost response retains the original choice; only that choice can be retried until a server read reconciles it. An RPC 401 triggers one identity-preserving token refresh and one idempotent retry, including when the browser clock is behind. Failed session refresh never silently creates a replacement identity. Clearing storage, another browser/device, or intentionally creating identities can permit extra votes: this is **one stored anonymous identity per PT day**, not one person. No app-owned IP address or fingerprint table is stored.

The primary key limits each identity to one accepted daily vote, including direct RPC abuse. Supabase Auth separately applies an IP-based anonymous-signup limit, currently 30 per hour, and returns 429 when exceeded. That limit does **not** rate-limit every RPC read/write. The client requires a user action for votes and prevents overlapping operations; these are courtesy controls, not bot protection. A future operator should review provider limits and CAPTCHA before a public launch. CAPTCHA needs a separate reviewed client integration; it is not enabled or claimed by this proposal. [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits), [anonymous abuse guidance](https://supabase.com/docs/guides/auth/auth-anonymous#abuse-prevention-and-rate-limits).

## Future operator setup (not performed)

1. Review an intended **Free** project and its existing Auth, Data API, schemas, grants, and quotas. Preserve existing state; do not reuse an unrelated database or enable paid features.
2. Inspect `proposal.sql`. Confirm `versus_private` and these RPC names do not already exist. Its transaction deliberately fails on conflicting existing objects rather than replacing them. On a local Supabase stack, use `supabase --help`, then `supabase migration --help` to discover the installed CLI commands; create a migration with `supabase migration new versus_poll` and copy this reviewed SQL into the generated file. Do not invent a migration timestamp, run the proposal remotely, or use a credential from the browser.
3. Run real local Postgres/Auth role checks before any security-rule deployment: missing/anonymous-only JWT rejected; signed-in anonymous user can add one current-day row; another user's ID, supplied day/time, invalid team, extra RPC args, bulk inserts, UPDATE and DELETE denied; duplicate concurrent writes retain exactly one row and original team; aggregate results reveal no other identity. Check server PT midnight and November 1 fall-back. Run the installed CLI's local database security advisors and resolve findings.
4. For a separately authorized cloud setup, enable anonymous sign-ins, retain/review provider IP limits, and choose any separately reviewed abuse controls. Keep only the required public RPC schema exposed; never expose `versus_private`. The SQL contains explicit grants because newly created objects are not automatically exposed under current Data API defaults. [Data API change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).
5. Put only the project's HTTPS URL and **publishable** key in `versus-config.json`, replacing both `null`s together. Example shape: `{"supabaseUrl":"https://YOUR_PROJECT.supabase.co","publishableKey":"sb_publishable_YOUR_PUBLIC_KEY"}`. The placeholder example is not usable. Never use a secret/service-role key or legacy JWT key. Publishable keys go on `apikey`; user access JWTs go on `Authorization: Bearer`. [Supabase key guidance](https://supabase.com/docs/guides/getting-started/api-keys).
6. Verify two independent browsers share results, one browser's tabs share an identity, repeated/ambiguous requests do not add votes, stale-day requests fail, storage blocking fails closed, and errors preserve clearly labeled last-loaded results. Verify in isolation without adding test votes to the existing live poll. Only then review the site release separately.

## Client/API contract

All requests are JSON POSTs with `credentials: 'omit'`, no caching, bounded client timeouts, and a publishable `apikey` header. Auth signup is `/auth/v1/signup` with `{data:{}}`; refresh is `/auth/v1/token?grant_type=refresh_token` with the saved refresh token. RPCs additionally send the user access JWT. The REST paths/bodies match the current official [Auth client source](https://github.com/supabase/auth-js/blob/master/src/GoTrueClient.ts).

| RPC | Body | Result |
| --- | --- | --- |
| `versus_results` | `{}` | `{day, open, dotsVotes, botsVotes, totalVotes, yourVote}` |
| `cast_versus_vote` | `{p_team: 'dots'\|'bots', p_expected_day: 'YYYY-MM-DD'}` | Same result plus `accepted: true\|false` |

The day is server-owned and counts must be nonnegative safe integers with a matching total. `yourVote` is `null`, `dots`, or `bots`. A duplicate returns `accepted:false` and the original choice. Missing Auth is rejected; `22023` means invalid team/day, `P0001` means closed, and Auth 429 means rate limited. The UI shows no raw provider error text or optimistic success. Results refresh on the site's interval and manual refresh; this proposal does not open a Realtime stream.

Health is exactly `100 - (100 * opponentVotes / max(totalVotes, 1)) * 0.9`. Valid vote splits therefore yield 10–100 health; a below-10 CSS warning is a defensive rendering threshold. Poll popularity does not decide the final data-based tracker winner.

## Verification delivered

```sh
node --test tests/versus-poll.test.js tests/supabase.test.js
node --check versus-poll.js
```

The client tests exercise locked tab identity, daily choices, refresh persistence, expiry, counts/formula, repeats, lost responses, storage failure, timeouts, and midnight rollover. The backend contract tests use **real local SQLite uniqueness plus mocked Auth/RLS/RPC behavior**, including 64 racing submissions, multiple identities, unauthorized/day-spoof/invalid-team inputs, final DST-day boundaries, and a simulated provider signup bucket. SQL assertions check the proposal's grants, policies, private aggregate, and invoker write guard. They are not a Postgres/Supabase emulator or a deployment test. No local Postgres or Supabase CLI is installed in this environment, so executing the actual proposal and provider-specific role/advisor checks remains an operator validation step before deployment.
