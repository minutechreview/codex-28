import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SupabaseContractMock, MOCK_CONFIG } from '../supabase/contract-mock.js';

const sql = readFileSync(new URL('../supabase/proposal.sql', import.meta.url), 'utf8');
function setup(t) {
  const server = new SupabaseContractMock(); t.after(() => server.close());
  const session = server.newSession();
  const call = (body = {}, token, path = 'cast_versus_vote') => server.fetch(`${MOCK_CONFIG.supabaseUrl}/rest/v1/rpc/${path}`, {
    method: 'POST', headers: { apikey: MOCK_CONFIG.publishableKey,
      Authorization: `Bearer ${token ?? server.newSession(session.user.id).access_token}` }, body: JSON.stringify(body),
  });
  return { server, call, session };
}

test('SQL proposal has one private table, server day, immutable rows and explicit role/RLS guards', () => {
  assert.equal((sql.match(/create table /gi) || []).length, 1);
  assert.match(sql, /create table versus_private\.votes/);
  assert.match(sql, /primary key \(vote_day, voter_id\)/);
  assert.match(sql, /default \(statement_timestamp\(\) at time zone 'America\/Los_Angeles'\)::date/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /grant insert \(voter_id, team\)/);
  assert.doesNotMatch(sql, /grant (?:update|delete|all).*votes/i);
  assert.match(sql, /with check \(voter_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /team in \('dots', 'bots'\)/);
  assert.match(sql, /p_expected_day <> v_day/);
  assert.match(sql, /on conflict \(vote_day, voter_id\) do nothing/);
  assert.match(sql, /v_inserted = 1/);
  const writer = sql.slice(sql.indexOf('create function public.cast_versus_vote'));
  assert.match(writer, /security invoker set search_path = ''/);
  assert.doesNotMatch(writer, /security definer/i);
  assert.match(writer, /if v_uid is null/);
});

test('privileged aggregation is private, auth checked, fixed-path, aggregate-only and narrowly granted', () => {
  const aggregate = sql.slice(sql.indexOf('create function versus_private.results'), sql.indexOf('create function public.versus_results'));
  assert.match(aggregate, /security definer set search_path = ''/);
  assert.match(aggregate, /if v_uid is null/);
  assert.match(aggregate, /max\(team\) filter \(where voter_id = v_uid\)/);
  assert.match(aggregate, /from versus_private\.votes where vote_day = v_day/);
  assert.match(aggregate, /revoke all on function versus_private\.results\(\) from public, anon, authenticated/);
  assert.match(aggregate, /grant execute.*to authenticated/);
  assert.doesNotMatch(aggregate.split('$$;')[0], /select \*|execute /i);
  // VOLATILE takes a fresh snapshot after the vote insert/conflict, avoiding stale acceptance payloads.
  assert.match(aggregate, /language plpgsql volatile/);
});

test('contract mock rejects missing identity, invalid team, date spoof and extra RPC arguments', async t => {
  const { call, server } = setup(t);
  const normal = { p_team: 'dots', p_expected_day: '2026-10-10' };
  assert.equal((await call(normal, 'not-authenticated')).status, 403);
  for (const body of [{ ...normal, p_team: 'admin' }, { ...normal, p_team: null },
    { ...normal, p_expected_day: '2026-10-09' }, { ...normal, p_expected_day: '2026-10-11' },
    { ...normal, p_expected_day: null }]) assert.equal((await call(body)).status, 400);
  for (const body of [{ ...normal, voter_id: 'another-user' }, { ...normal, increment: 100 },
    { ...normal, vote_day: '2026-10-09' }]) assert.equal((await call(body)).status, 404);
  assert.equal(server.results('unused').totalVotes, 0);
});

test('SQLite-backed atomic uniqueness counts one +1 row across 64 conflicting concurrent RPC attempts', async t => {
  const { call, server } = setup(t);
  const results = await Promise.all(Array.from({ length: 64 }, async (_, n) => (await call({
    p_team: n % 2 ? 'bots' : 'dots', p_expected_day: '2026-10-10',
  })).json()));
  assert.equal(results.filter(result => result.accepted).length, 1);
  assert.equal(server.results('unused').totalVotes, 1);
  assert.ok(results.every(result => result.yourVote === 'dots'));
});

test('distinct identities each count once and original choices are immutable', async t => {
  const { server, call } = setup(t);
  const users = Array.from({ length: 20 }, () => server.newSession());
  const responses = await Promise.all(users.flatMap((user, n) => ['dots', 'bots'].map(team => call({
    p_team: n % 2 ? team : team === 'dots' ? 'bots' : 'dots', p_expected_day: server.day(),
  }, user.access_token).then(response => response.json()))));
  assert.equal(responses.filter(result => result.accepted).length, 20);
  const counts = server.results('unused'); assert.equal(counts.totalVotes, 20); assert.equal(counts.dotsVotes, 10); assert.equal(counts.botsVotes, 10);
});

test('server Pacific day boundaries, final DST fall-back and active window cannot be client overridden', async t => {
  const { server, call } = setup(t);
  server.now = new Date('2026-10-05T06:59:59Z');
  assert.equal((await call({ p_team: 'dots', p_expected_day: '2026-10-04' })).status, 400);
  server.now = new Date('2026-10-05T07:00:00Z');
  assert.equal((await (await call({ p_team: 'dots', p_expected_day: '2026-10-05' })).json()).accepted, true);
  server.now = new Date('2026-11-01T06:59:59Z'); assert.equal(server.day(), '2026-10-31');
  server.now = new Date('2026-11-01T07:00:00Z'); assert.equal(server.day(), '2026-11-01');
  assert.equal((await (await call({ p_team: 'bots', p_expected_day: '2026-11-01' })).json()).accepted, true);
  for (const now of ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-02T07:59:59Z']) {
    server.now = new Date(now); assert.equal(server.day(), '2026-11-01');
    assert.equal((await (await call({ p_team: 'dots', p_expected_day: '2026-11-01' })).json()).accepted, false);
  }
  server.now = new Date('2026-11-02T08:00:00Z'); assert.equal(server.day(), '2026-11-02');
  assert.equal((await call({ p_team: 'dots', p_expected_day: '2026-11-02' })).status, 400);
});

test('mock provider Auth IP bucket rejects the 31st anonymous signup and later recovers', async t => {
  const { server } = setup(t);
  const signup = () => server.fetch(`${MOCK_CONFIG.supabaseUrl}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: MOCK_CONFIG.publishableKey }, body: JSON.stringify({ data: {} }),
  });
  for (let n = 0; n < 30; n++) assert.equal((await signup()).status, 200);
  assert.equal((await signup()).status, 429);
  server.now = new Date(server.now.getTime() + 3600001); assert.equal((await signup()).status, 200);
});
