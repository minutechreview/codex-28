import test from 'node:test';
import assert from 'node:assert/strict';
import { browserIdentity, VOTER_STORAGE_KEY } from '../polls.js';
import { dateInTimezone } from '../model.js';
import { VersusPollStore, validateVersusConfig, validateVersusResult, voteHealth, votePercentages,
  DAY_CHOICE_KEY, DEVICE_LOCK_KEY } from '../versus-poll.js';

const CONFIG = Object.freeze({ apiBaseUrl: 'https://worker-team.test' });
const VOTER = '12345678-1234-4123-8123-123456789abc';
const counts = (values = {}) => ({ day: '2026-10-10', open: true, dotsVotes: 0, botsVotes: 0,
  totalVotes: 0, yourVote: null, ...values });
function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function mockLocks() {
  const queues = new Map();
  return { request(name, options, callback) {
    const next = (queues.get(name) ?? Promise.resolve()).catch(() => {}).then(() => {
      options.signal?.throwIfAborted(); return callback();
    });
    queues.set(name, next); return next;
  } };
}
/** Local HTTP contract mock. Actual Worker/D1 atomic guards have independent tests. */
class WorkerMock {
  constructor() {
    this.now = new Date('2026-10-10T20:00:00Z'); this.votes = new Map(); this.calls = [];
    this.failReads = false; this.failVotes = false; this.loseNextVote = false; this.voteRequests = 0;
    this.fetch = this.fetch.bind(this);
  }
  day() { return dateInTimezone(this.now, 'America/Los_Angeles'); }
  result(day, voterId, accepted) {
    const rows = [...this.votes.entries()].filter(([key]) => key.startsWith(`${day}:`));
    const dotsVotes = rows.filter(([, choice]) => choice === 'dots').length;
    const botsVotes = rows.filter(([, choice]) => choice === 'bots').length;
    return { day, open: day >= '2026-10-05' && day <= '2026-11-01', dotsVotes, botsVotes,
      totalVotes: dotsVotes + botsVotes, yourVote: this.votes.get(`${day}:${voterId}`) ?? null,
      ...(accepted !== undefined ? { accepted } : {}) };
  }
  async fetch(value, init = {}) {
    const url = new URL(value), method = init.method ?? 'GET';
    const day = url.pathname.match(/^\/teams\/(\d{4}-\d{2}-\d{2})$/)?.[1];
    const body = init.body ? JSON.parse(init.body) : null;
    this.calls.push({ url: value, method, body });
    assert.ok(day, 'Only isolated team routes may be called');
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    if (day !== this.day()) return Response.json({ error: 'day_closed' }, { status: 410 });
    if (method === 'GET') {
      if (this.failReads) return Response.json({ error: 'database_unavailable' }, { status: 503 });
      assert.deepEqual([...url.searchParams.keys()], ['voterId']);
      return Response.json(this.result(day, url.searchParams.get('voterId')));
    }
    assert.equal(method, 'POST'); this.voteRequests++;
    assert.deepEqual(Object.keys(body).sort(), ['choice', 'voterId']);
    assert.ok(['dots', 'bots'].includes(body.choice));
    if (this.failVotes) return Response.json({ error: 'database_unavailable' }, { status: 503 });
    if (!this.result(day, body.voterId).open) return Response.json({ error: 'day_closed' }, { status: 410 });
    const key = `${day}:${body.voterId}`, accepted = !this.votes.has(key);
    if (accepted) this.votes.set(key, body.choice);
    if (this.loseNextVote) { this.loseNextVote = false; throw new Error('Lost committed response'); }
    return Response.json(this.result(day, body.voterId, accepted));
  }
}
function setup(overrides = {}) {
  const server = new WorkerMock(), storage = memoryStorage(), locks = mockLocks();
  const cryptoImpl = { randomUUID: () => VOTER };
  const store = new VersusPollStore({ fetchImpl: server.fetch, storage, locks, cryptoImpl,
    now: () => server.now, ...overrides });
  store.setConfig(CONFIG); return { server, storage, locks, store, cryptoImpl };
}

test('null config stays COMING SOON without identity creation or service calls', async () => {
  const config = validateVersusConfig({ apiBaseUrl: null }, 'https://example.com');
  let calls = 0; const storage = memoryStorage();
  const store = new VersusPollStore({ storage, fetchImpl: async () => { calls++; } }); store.setConfig(config);
  await store.load(); await store.vote('dots');
  assert.equal(store.phase, 'coming-soon'); assert.equal(store.result, null); assert.equal(calls, 0);
  assert.equal(storage.values.size, 0);
});
test('team config reuses secure Worker URL validation without credentials', () => {
  assert.deepEqual(validateVersusConfig(CONFIG, 'https://example.com'), CONFIG);
  assert.equal(validateVersusConfig({ apiBaseUrl: 'http://127.0.0.1:8787/' }, 'http://localhost:4173').apiBaseUrl, 'http://127.0.0.1:8787');
  for (const config of [{ apiBaseUrl: 'javascript:alert(1)' }, { apiBaseUrl: 'https://user:secret@worker-team.test' },
    { apiBaseUrl: 'https://worker-team.test/?key=secret' }, { apiBaseUrl: 'http://127.0.0.1:8787' },
    { ...CONFIG, key: 'private' }, { apiBaseUrl: 'https://worker-team.test/\n' }]) {
    assert.throws(() => validateVersusConfig(config, 'https://example.com'));
  }
});
test('health exactly follows opposing votes, including empty and extreme splits', () => {
  assert.deepEqual(voteHealth(counts()), { tiboHealth: 100, potetoHealth: 100 });
  assert.deepEqual(voteHealth(counts({ dotsVotes: 1, totalVotes: 1 })), { tiboHealth: 100, potetoHealth: 10 });
  assert.deepEqual(voteHealth(counts({ botsVotes: 1, totalVotes: 1 })), { tiboHealth: 10, potetoHealth: 100 });
  assert.deepEqual(voteHealth(counts({ dotsVotes: 1, botsVotes: 1, totalVotes: 2 })), { tiboHealth: 55, potetoHealth: 55 });
  assert.deepEqual(votePercentages(counts()), { dots: 0, bots: 0 });
  assert.deepEqual(votePercentages(counts({ dotsVotes: 2, botsVotes: 1, totalVotes: 3 })), { dots: 67, bots: 33 });
});
test('malformed or cross-day responses cannot become counts or choices', () => {
  assert.deepEqual(validateVersusResult(counts()), counts());
  for (const changes of [{ day: '2026-02-30' }, { totalVotes: 1 }, { dotsVotes: -1 }, { botsVotes: 0.5 },
    { open: undefined }, { yourVote: 'other' }, { accepted: 'true' }, { yourVote: 'dots' },
    { dotsVotes: Number.MAX_SAFE_INTEGER, botsVotes: 1, totalVotes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => validateVersusResult(counts(changes)));
  }
  assert.throws(() => validateVersusResult(counts(), '2026-10-11'));
});
test('existing browser UUID is reused on GET/POST without modifying approval hints', async () => {
  const { store, server, storage } = setup();
  storage.setItem(VOTER_STORAGE_KEY, VOTER); storage.setItem('existing-approval-hint', 'preserve');
  await store.refresh(); await store.vote('dots');
  assert.equal(store.identity.voterId, VOTER); assert.equal(DEVICE_LOCK_KEY, VOTER_STORAGE_KEY);
  assert.equal(new URL(server.calls[0].url).searchParams.get('voterId'), VOTER);
  assert.deepEqual(server.calls[1].body, { voterId: VOTER, choice: 'dots' });
  assert.equal(storage.getItem('existing-approval-hint'), 'preserve');
});
test('reload retains identity and server choice without storing authoritative counts', async () => {
  const { store, server, storage, locks, cryptoImpl } = setup(); await store.refresh(); await store.vote('dots');
  assert.equal(store.result.accepted, true); assert.equal(store.result.totalVotes, 1);
  const other = new VersusPollStore({ storage, locks, cryptoImpl, fetchImpl: server.fetch, now: () => server.now });
  other.setConfig(CONFIG); await other.refresh(); await other.vote('bots');
  assert.equal(server.voteRequests, 1); assert.equal(other.result.yourVote, 'dots');
  assert.ok([...storage.values.keys()].every(key => key === VOTER_STORAGE_KEY || key.startsWith(DAY_CHOICE_KEY)));
  assert.ok([...storage.values.values()].every(value => !/dotsVotes|botsVotes|totalVotes/.test(value)));
});
test('shared approval identity may be injected without creating another UUID', async () => {
  const { store, server, storage, cryptoImpl } = setup();
  const identity = browserIdentity(storage, cryptoImpl); store.setConfig(CONFIG, identity);
  await store.refresh(); assert.equal(store.identity.voterId, identity.voterId);
  assert.equal(new URL(server.calls[0].url).searchParams.get('voterId'), identity.voterId);
});
test('two new tabs share one locked UUID and racing opposite votes add one row', async () => {
  const { server, store, storage, locks } = setup(); let creations = 0;
  const cryptoImpl = { randomUUID: () => { creations++; return VOTER; } }; store.cryptoImpl = cryptoImpl;
  const other = new VersusPollStore({ fetchImpl: server.fetch, storage, locks, cryptoImpl, now: () => server.now }); other.setConfig(CONFIG);
  await Promise.all([store.refresh(), other.refresh()]); assert.equal(creations, 1);
  await Promise.all([store.vote('dots'), other.vote('bots')]); await other.refresh();
  assert.equal(server.votes.size, 1); assert.equal(server.voteRequests, 1); assert.equal(other.result.yourVote, 'dots');
});
test('atomic duplicates honor the original server choice without another increment', async () => {
  const { store, server } = setup(); await store.refresh();
  server.votes.set(`${server.day()}:${VOTER}`, 'bots'); await store.vote('dots');
  assert.equal(store.phase, 'ready'); assert.equal(store.result.accepted, false);
  assert.equal(store.result.yourVote, 'bots'); assert.equal(store.result.totalVotes, 1);
});
test('defensive HTTP409 duplicates also honor the original choice', async () => {
  const { store } = setup(); await store.refresh(); const realFetch = store.fetchImpl;
  store.fetchImpl = async (url, init) => init.method === 'POST'
    ? Response.json(counts({ botsVotes: 1, totalVotes: 1, yourVote: 'bots', accepted: false }), { status: 409 }) : realFetch(url, init);
  await store.vote('dots'); assert.equal(store.phase, 'ready'); assert.equal(store.result.yourVote, 'bots');
});
test('lost response retains prior counts and only permits the original choice retry', async () => {
  const { store, server } = setup(); await store.refresh(); server.loseNextVote = true; await store.vote('dots');
  assert.equal(store.phase, 'vote-error'); assert.equal(store.result.totalVotes, 0); assert.equal(store.pendingTeam, 'dots');
  await store.vote('bots'); assert.equal(server.voteRequests, 1); await store.vote('dots');
  assert.equal(store.phase, 'ready'); assert.equal(store.result.accepted, false); assert.equal(store.result.totalVotes, 1);
});
test('GET reconciles a lost committed response without reposting', async () => {
  const { store, server } = setup(); await store.refresh(); server.loseNextVote = true;
  await store.vote('bots'); await store.refresh(); await store.vote('bots');
  assert.equal(server.voteRequests, 1); assert.equal(store.phase, 'ready'); assert.equal(store.pendingTeam, null);
  assert.equal(store.result.yourVote, 'bots');
});
test('failure before commit retains pending side across tabs and permits same-side retry after GET', async () => {
  const { store, server, storage, locks, cryptoImpl } = setup(); await store.refresh();
  const other = new VersusPollStore({ fetchImpl: server.fetch, storage, locks, cryptoImpl, now: () => server.now });
  other.setConfig(CONFIG); await other.refresh(); const realFetch = store.fetchImpl;
  store.fetchImpl = async (url, init) => { if (init.method === 'POST') throw new Error('offline before commit'); return realFetch(url, init); };
  await store.vote('dots'); await other.vote('bots');
  assert.equal(other.phase, 'vote-error'); assert.equal(other.pendingTeam, 'dots'); assert.equal(server.voteRequests, 0);
  await other.refresh(); assert.equal(other.errorStatus, null); assert.equal(other.phase, 'vote-error');
  await other.vote('dots'); assert.equal(other.result.yourVote, 'dots'); assert.equal(other.result.totalVotes, 1);
});
test('inconsistent accepted response preserves prior counts and pending side', async () => {
  const { store } = setup(); await store.refresh(); const realFetch = store.fetchImpl;
  store.fetchImpl = async (url, init) => init.method === 'POST'
    ? Response.json(counts({ botsVotes: 1, totalVotes: 1, yourVote: 'bots', accepted: true })) : realFetch(url, init);
  await store.vote('dots'); assert.equal(store.phase, 'vote-error'); assert.equal(store.result.totalVotes, 0);
  assert.equal(store.pendingTeam, 'dots'); assert.equal(store.errorCode, 'invalid_confirmation');
});
test('read errors preserve last counts while initial failures leave counts unknown', async () => {
  const { store, server } = setup(); server.failReads = true; await store.refresh();
  assert.equal(store.phase, 'read-error'); assert.equal(store.result, null);
  server.failReads = false; await store.refresh(); await store.vote('dots'); server.failReads = true; await store.refresh();
  assert.equal(store.phase, 'read-error'); assert.equal(store.result.totalVotes, 1);
  server.failReads = false; await store.refresh(); assert.equal(store.phase, 'ready');
});
test('blocked storage, missing locks or failed persistence prevents requests', async () => {
  for (const overrides of [{ storage: null }, { locks: null }, { storage: { getItem() { throw new Error('blocked'); } } },
    { storage: { getItem: () => null, setItem() {} } }]) {
    const { store, server } = setup(overrides); await store.refresh(); await store.vote('dots');
    assert.equal(store.phase, 'storage-error'); assert.equal(server.calls.length, 0);
  }
});
test('corrupted local hints fail closed instead of supplying stored counts', async () => {
  const { store, storage } = setup(); await store.refresh();
  storage.setItem(store.choiceKey('2026-10-10'), JSON.stringify({ team: 'dots', phase: 'pending', totalVotes: 900 }));
  await store.vote('dots'); assert.equal(store.phase, 'storage-error'); assert.equal(store.result.totalVotes, 0);
});
test('429 rate limits retain pending side without assuming a successful vote', async () => {
  const { store } = setup(); await store.refresh(); const realFetch = store.fetchImpl;
  store.fetchImpl = async (url, init) => init.method === 'POST'
    ? Response.json({ error: 'rate_limited' }, { status: 429 }) : realFetch(url, init);
  await store.vote('dots'); assert.equal(store.errorStatus, 429); assert.equal(store.pendingTeam, 'dots');
  assert.equal(store.result.totalVotes, 0); await store.vote('bots'); assert.equal(store.result.totalVotes, 0);
});
test('native fetch receiver remains globalThis', async () => {
  const { server, storage, locks, cryptoImpl } = setup();
  const store = new VersusPollStore({ storage, locks, cryptoImpl, now: () => server.now,
    fetchImpl: function (url, init) { assert.equal(this, globalThis); return server.fetch(url, init); } });
  store.setConfig(CONFIG); await store.refresh(); assert.equal(store.phase, 'ready');
});
test('PT rollover clears the old result and allows a fresh daily vote on the same UUID', async () => {
  const { store, server } = setup(); server.now = new Date('2026-10-11T06:59:59Z'); await store.refresh(); await store.vote('dots');
  server.now = new Date('2026-10-11T07:00:00Z'); await store.refresh();
  assert.equal(store.pendingTeam, null); assert.equal(store.result.day, '2026-10-11'); assert.equal(store.result.yourVote, null);
  await store.vote('bots'); assert.equal(store.result.totalVotes, 1); assert.equal(server.votes.size, 2);
});
test('a stale-day click refreshes without transferring its choice to a new round', async () => {
  const { store, server } = setup(); server.now = new Date('2026-10-11T06:59:59Z'); await store.refresh();
  server.now = new Date('2026-10-11T07:00:00Z'); await store.vote('dots');
  assert.equal(server.voteRequests, 0); assert.equal(store.result.day, '2026-10-11'); assert.equal(store.phase, 'ready');
  await store.vote('bots'); assert.equal(store.result.totalVotes, 1);
});
test('GET crossing midnight installs fresh-day counts only', async () => {
  const { store, server } = setup(); server.now = new Date('2026-10-11T06:59:59Z'); const realFetch = store.fetchImpl;
  let crossed = false;
  store.fetchImpl = async (url, init) => {
    const response = await realFetch(url, init); if (!crossed) { crossed = true; server.now = new Date('2026-10-11T07:00:00Z'); }
    return response;
  };
  await store.refresh(); assert.equal(store.result.day, '2026-10-11'); assert.equal(server.calls.length, 2);
});
test('POST crossing midnight confirms the old hint and displays a fresh-day poll', async () => {
  const { store, server, storage } = setup(); server.now = new Date('2026-10-11T06:59:59Z'); await store.refresh();
  const realFetch = store.fetchImpl;
  store.fetchImpl = async (url, init) => { const response = await realFetch(url, init);
    if (init.method === 'POST') server.now = new Date('2026-10-11T07:00:00Z'); return response; };
  await store.vote('dots'); assert.equal(store.result.day, '2026-10-11'); assert.equal(store.result.totalVotes, 0);
  assert.deepEqual(JSON.parse(storage.getItem(store.choiceKey('2026-10-10'))), { team: 'dots', phase: 'confirmed' });
});
test('outside the tracker window results are read-only and no POST is sent', async () => {
  const { store, server } = setup(); server.now = new Date('2026-11-02T08:00:00Z'); await store.refresh();
  assert.equal(store.phase, 'closed'); assert.equal(store.result.open, false); await store.vote('dots'); assert.equal(server.voteRequests, 0);
});
test('server410 closes a skewed-clock day without inventing counts', async () => {
  const { store, server } = setup({ now: () => new Date('2026-10-09T20:00:00Z') }); await store.refresh();
  assert.equal(store.phase, 'closed'); assert.equal(store.errorStatus, 410); assert.equal(store.result, null); assert.equal(server.voteRequests, 0);
});
test('nested Worker error codes are retained while untrusted server messages are discarded', async () => {
  const { store } = setup();
  store.fetchImpl = async () => Response.json({ error: { code: 'day_closed', message: '<script>private diagnostic</script>' } }, { status: 410 });
  await store.refresh(); assert.equal(store.errorCode, 'day_closed'); assert.equal(store.errorStatus, 410);
  assert.equal(store.phase, 'closed'); assert.equal(store.result, null);
});
test('a late click after yesterday was already voted refreshes instead of staying locked to yesterday', async () => {
  const { store, server } = setup(); await store.refresh(); await store.vote('dots');
  server.now = new Date('2026-10-11T07:00:00Z'); await store.vote('bots');
  assert.equal(server.voteRequests, 1); assert.equal(store.result.day, '2026-10-11'); assert.equal(store.result.yourVote, null);
});
test('a GET rejected after PT midnight retries only the new day', async () => {
  const { store, server } = setup(); server.now = new Date('2026-10-11T06:59:59Z'); const realFetch = store.fetchImpl;
  let crossed = false;
  store.fetchImpl = async (url, init) => {
    if (!crossed) { crossed = true; server.now = new Date('2026-10-11T07:00:00Z'); }
    return realFetch(url, init);
  };
  await store.refresh(); assert.equal(store.phase, 'ready'); assert.equal(store.result.day, '2026-10-11');
  assert.equal(server.calls.length, 2);
});
test('request timeout aborts cleanly without counts or a fabricated vote', async () => {
  const { store } = setup({ timeoutMs: 5, fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  await store.refresh(); assert.equal(store.phase, 'read-error'); assert.equal(store.result, null);
});
test('reconfiguring to COMING SOON discards a late response from the old endpoint', async () => {
  const { store } = setup(); let finish; store.fetchImpl = () => new Promise(resolve => { finish = resolve; });
  const request = store.refresh(); await Promise.resolve(); await Promise.resolve();
  store.setConfig({ apiBaseUrl: null }); finish(Response.json(counts())); await request;
  assert.equal(store.phase, 'coming-soon'); assert.equal(store.result, null);
});
