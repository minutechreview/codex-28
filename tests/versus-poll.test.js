import test from 'node:test';
import assert from 'node:assert/strict';
import { VersusPollStore, validateVersusConfig, validateVersusResult, voteHealth, votePercentages,
  SESSION_KEY, DAY_CHOICE_KEY } from '../versus-poll.js';
import { SupabaseContractMock, MOCK_CONFIG, memoryStorage, mockLocks } from '../supabase/contract-mock.js';

const counts = (values = {}) => ({ day: '2026-10-10', open: true, dotsVotes: 0, botsVotes: 0,
  totalVotes: 0, yourVote: null, ...values });
function setup(t, overrides = {}) {
  const server = new SupabaseContractMock(); t.after(() => server.close());
  const storage = memoryStorage(); const locks = mockLocks();
  const store = new VersusPollStore({ fetchImpl: server.fetch, storage, locks, now: () => server.now, ...overrides });
  store.setConfig(MOCK_CONFIG); return { server, storage, locks, store };
}

test('null public config is honest COMING SOON and makes no provider requests', async () => {
  const config = validateVersusConfig({ supabaseUrl: null, publishableKey: null }, 'https://example.com');
  let calls = 0;
  const store = new VersusPollStore({ fetchImpl: async () => { calls++; } }); store.setConfig(config);
  await store.load(); await store.vote('dots');
  assert.equal(store.phase, 'coming-soon'); assert.equal(store.result, null); assert.equal(calls, 0);
});

test('configuration permits only publishable keys and explicit safe origins', () => {
  assert.deepEqual(validateVersusConfig(MOCK_CONFIG, 'https://example.com'), MOCK_CONFIG);
  assert.equal(validateVersusConfig({ ...MOCK_CONFIG, supabaseUrl: 'http://127.0.0.1:54321' }, 'http://localhost:4173').supabaseUrl, 'http://127.0.0.1:54321');
  for (const config of [{ ...MOCK_CONFIG, publishableKey: 'sb_secret_privatecredential' },
    { ...MOCK_CONFIG, publishableKey: 'eyJlegacyServiceRoleJWT' }, { ...MOCK_CONFIG, supabaseUrl: 'https://evil.example' },
    { ...MOCK_CONFIG, supabaseUrl: 'https://user:secret@versus-test.supabase.co' },
    { ...MOCK_CONFIG, supabaseUrl: 'https://versus-test.supabase.co/?key=secret' },
    { ...MOCK_CONFIG, supabaseUrl: 'http://127.0.0.1:54321' }, { ...MOCK_CONFIG, extra: true }]) {
    assert.throws(() => validateVersusConfig(config, 'https://example.com'));
  }
});

test('health follows the requested equation, including zero and extreme vote splits', () => {
  assert.deepEqual(voteHealth(counts()), { tiboHealth: 100, potetoHealth: 100 });
  assert.deepEqual(voteHealth(counts({ dotsVotes: 1, totalVotes: 1 })), { tiboHealth: 100, potetoHealth: 10 });
  assert.deepEqual(voteHealth(counts({ botsVotes: 1, totalVotes: 1 })), { tiboHealth: 10, potetoHealth: 100 });
  assert.deepEqual(voteHealth(counts({ dotsVotes: 1, botsVotes: 1, totalVotes: 2 })), { tiboHealth: 55, potetoHealth: 55 });
  assert.deepEqual(votePercentages(counts()), { dots: 0, bots: 0 });
  assert.deepEqual(votePercentages(counts({ dotsVotes: 2, botsVotes: 1, totalVotes: 3 })), { dots: 67, bots: 33 });
});

test('malformed server results never become fabricated counts or recorded votes', () => {
  assert.deepEqual(validateVersusResult(counts()), counts());
  for (const changes of [{ day: '2026-02-30' }, { totalVotes: 1 }, { dotsVotes: -1 }, { botsVotes: 0.5 },
    { open: undefined }, { yourVote: 'other' }, { accepted: 'true' }, { yourVote: 'dots' },
    { dotsVotes: Number.MAX_SAFE_INTEGER, botsVotes: 1, totalVotes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => validateVersusResult(counts(changes)));
  }
});

test('a reload retains anonymous identity and choice; storage never holds authoritative counts', async t => {
  const { store, server, storage, locks } = setup(t);
  await store.refresh(); await store.vote('dots');
  assert.equal(store.result.accepted, true); assert.equal(store.result.totalVotes, 1);
  assert.equal(store.result.yourVote, 'dots');
  const reloaded = new VersusPollStore({ storage, locks, fetchImpl: server.fetch, now: () => server.now });
  reloaded.setConfig(MOCK_CONFIG); await reloaded.refresh(); await reloaded.vote('bots');
  assert.equal(server.signups, 1); assert.equal(server.voteRequests, 1); assert.equal(reloaded.result.yourVote, 'dots');
  assert.ok([...storage.values.keys()].every(key => key.startsWith(SESSION_KEY) || key.startsWith(DAY_CHOICE_KEY)));
  assert.ok([...storage.values.values()].every(value => !/dotsVotes|botsVotes|totalVotes/.test(value)));
});

test('two new tabs share a locked identity and racing opposite choices record one row', async t => {
  const { server, store, storage, locks } = setup(t);
  const other = new VersusPollStore({ fetchImpl: server.fetch, storage, locks, now: () => server.now }); other.setConfig(MOCK_CONFIG);
  await Promise.all([store.refresh(), other.refresh()]);
  assert.equal(server.signups, 1);
  await Promise.all([store.vote('dots'), other.vote('bots')]);
  await other.refresh();
  assert.equal(server.results('unused').totalVotes, 1); assert.equal(other.result.yourVote, 'dots');
});

test('lost vote response keeps prior counts and permits only the original choice retry', async t => {
  const { store, server } = setup(t); await store.refresh(); server.loseNextVote = true;
  await store.vote('dots');
  assert.equal(store.phase, 'vote-error'); assert.equal(store.result.totalVotes, 0); assert.equal(store.pendingTeam, 'dots');
  await store.vote('bots'); assert.equal(server.voteRequests, 1);
  await store.vote('dots');
  assert.equal(store.phase, 'ready'); assert.equal(store.result.accepted, false); assert.equal(store.result.totalVotes, 1);
});

test('a read reconciles an ambiguously committed vote without submitting it again', async t => {
  const { store, server } = setup(t); await store.refresh(); server.loseNextVote = true;
  await store.vote('bots'); await store.refresh(); await store.vote('bots');
  assert.equal(server.voteRequests, 1); assert.equal(store.phase, 'ready'); assert.equal(store.pendingTeam, null);
  assert.equal(store.result.yourVote, 'bots');
});

test('a second tab cannot change a pending first-tab choice and retries retain its team', async t => {
  const { store, server, storage, locks } = setup(t); await store.refresh();
  const other = new VersusPollStore({ fetchImpl: server.fetch, storage, locks, now: () => server.now });
  other.setConfig(MOCK_CONFIG); await other.refresh();
  // Model a request failing before commit, so the saved choice still needs a retry.
  const realFetch = store.fetchImpl;
  store.fetchImpl = async (url, init) => {
    if (url.endsWith('/cast_versus_vote')) throw new Error('offline before commit');
    return realFetch(url, init);
  };
  await store.vote('dots'); await other.vote('bots');
  assert.equal(other.phase, 'vote-error'); assert.equal(other.pendingTeam, 'dots');
  assert.equal(server.voteRequests, 0);
  await other.vote('dots'); assert.equal(other.result.yourVote, 'dots'); assert.equal(other.result.totalVotes, 1);
});

test('an inconsistent accepted response preserves prior results and pending retry', async t => {
  const { store } = setup(t); await store.refresh();
  const realFetch = store.fetchImpl;
  store.fetchImpl = async (url, init) => url.endsWith('/cast_versus_vote')
    ? Response.json(counts({ botsVotes: 1, totalVotes: 1, yourVote: 'bots', accepted: true }))
    : realFetch(url, init);
  await store.vote('dots');
  assert.equal(store.phase, 'vote-error'); assert.equal(store.result.totalVotes, 0);
  assert.equal(store.pendingTeam, 'dots'); assert.equal(store.errorCode, 'invalid_confirmation');
});

test('read errors preserve last counts and first read errors leave results unknown', async t => {
  const { store, server } = setup(t); server.failReads = true; await store.refresh();
  assert.equal(store.phase, 'read-error'); assert.equal(store.result, null);
  server.failReads = false; await store.refresh(); await store.vote('dots');
  server.failReads = true; await store.refresh();
  assert.equal(store.phase, 'read-error'); assert.equal(store.result.totalVotes, 1);
  server.failReads = false; await store.refresh(); assert.equal(store.phase, 'ready');
});

test('storage/locks unavailable prevents anonymous identity creation and vote submission', async t => {
  for (const overrides of [{ storage: null }, { locks: null },
    { storage: { getItem() { throw new Error('blocked'); } } },
    { storage: { getItem: () => null, setItem() {} } }]) {
    const { store, server } = setup(t, overrides); await store.refresh(); await store.vote('dots');
    assert.equal(store.phase, 'storage-error'); assert.equal(server.signups, 0); assert.equal(server.voteRequests, 0);
  }
});

test('session refresh preserves the same identity and a failed refresh never signs up anew', async t => {
  const { store, server, storage } = setup(t); await store.refresh(); await store.vote('dots');
  const before = JSON.parse(storage.getItem(store.sessionKey)); server.now = new Date('2026-10-10T21:00:00Z');
  await store.refresh(); const after = JSON.parse(storage.getItem(store.sessionKey));
  assert.equal(after.userId, before.userId); assert.notEqual(after.refreshToken, before.refreshToken);
  assert.equal(store.result.totalVotes, 1); assert.equal(server.signups, 1);
  server.refreshTokens.clear(); server.now = new Date('2026-10-10T22:00:00Z'); await store.refresh();
  assert.equal(store.phase, 'read-error'); assert.equal(server.signups, 1); assert.equal(store.result.totalVotes, 1);
});

test('an expired access token refreshes once with clock skew and preserves identity and choice', async t => {
  const { store, server, storage } = setup(t, { now: () => new Date('2026-10-10T19:55:00Z') });
  await store.refresh(); await store.vote('dots'); const before = JSON.parse(storage.getItem(store.sessionKey));
  server.now = new Date('2026-10-10T21:00:00Z');
  // Client clock is behind; local expiry comparison still considers this token valid.
  store.now = () => new Date(server.now.getTime() - 5 * 60 * 1000);
  await store.refresh(); const after = JSON.parse(storage.getItem(store.sessionKey));
  assert.equal(store.phase, 'ready'); assert.equal(store.result.yourVote, 'dots'); assert.equal(store.result.totalVotes, 1);
  assert.equal(after.userId, before.userId); assert.notEqual(after.accessToken, before.accessToken); assert.equal(server.signups, 1);
});

test('persistently rejected RPC access retries only once after refreshing the same identity', async t => {
  const { store, server } = setup(t); let rpcCalls = 0;
  store.fetchImpl = async (url, init) => {
    if (url.includes('/rest/v1/rpc/')) { rpcCalls++; return Response.json({ code: 'PGRST301' }, { status: 401 }); }
    return server.fetch(url, init);
  };
  await store.refresh(); assert.equal(rpcCalls, 2); assert.equal(server.signups, 1);
  assert.equal(store.phase, 'read-error'); assert.equal(store.result, null); assert.equal(store.errorStatus, 401);
});

test('the fetch adapter retains the native global receiver', async t => {
  const { server, storage, locks } = setup(t);
  const store = new VersusPollStore({ storage, locks, now: () => server.now,
    fetchImpl: function (url, init) { assert.equal(this, globalThis); return server.fetch(url, init); } });
  store.setConfig(MOCK_CONFIG); await store.refresh(); assert.equal(store.phase, 'ready');
});

test('Pacific rollover gives the same device a fresh daily vote but rejects a stale-day submission', async t => {
  const { store, server } = setup(t); server.now = new Date('2026-10-11T06:59:59Z');
  await store.refresh(); server.now = new Date('2026-10-11T07:00:00Z'); await store.vote('dots');
  assert.equal(store.phase, 'vote-error'); assert.equal(store.errorCode, '22023'); assert.equal(server.results('unused').totalVotes, 0);
  await store.refresh(); assert.equal(store.pendingTeam, null); assert.equal(store.result.day, '2026-10-11');
  await store.vote('bots'); assert.equal(store.result.totalVotes, 1);
});

test('request timeout aborts cleanly without assuming counts', async t => {
  const { store } = setup(t, { timeoutMs: 5, fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  await store.refresh(); assert.equal(store.phase, 'read-error'); assert.equal(store.result, null);
});
