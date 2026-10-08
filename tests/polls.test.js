import test from 'node:test';
import assert from 'node:assert/strict';
import { pollIdFor, validateVotingConfig, browserIdentity, VOTER_STORAGE_KEY,
  validatePollResult, votePercentages, PollStore } from '../polls.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ID = 'codex-28:2026-10-05:day-1';
const SECOND_ID = 'codex-28:2026-10-06:day-2';
const identity = { voterId: UUID, available: true };
const entry = { day: 1, date: '2026-10-05', status: 'improvement', summary: 'An update', tweetUrl: null };
const result = (pollId = ID, values = {}) => ({ pollId, approve: 2, notConvinced: 1, total: 3, yourVote: null, ...values });
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function storeFor(fetchImpl, browser = identity) {
  const store = new PollStore({ fetchImpl, identity: browser });
  store.setConfig({ apiBaseUrl: 'https://votes.example.test' });
  return store;
}
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('poll IDs remain stable through summary, link, and same-day outcome edits', () => {
  assert.equal(pollIdFor(entry, '2026-10-08'), ID);
  assert.equal(pollIdFor({ ...entry, summary: 'Edited text', tweetUrl: 'https://x.com/thsottiaux/status/123', status: 'reset' }, '2026-10-09'), ID);
  assert.equal(pollIdFor({ ...entry, day: 2, date: '2026-10-06' }, '2026-10-08'), SECOND_ID);
});

test('pending, future, invalid and out-of-window entries never expose a poll', () => {
  for (const invalid of [null, { ...entry, status: 'pending' }, { ...entry, status: 'unknown' },
    { ...entry, day: 0 }, { ...entry, day: 29 }, { ...entry, day: 1.5 },
    { ...entry, date: '2026-02-30' }, { ...entry, date: '26-10-05' }]) {
    assert.equal(pollIdFor(invalid, '2026-10-08'), null);
  }
  assert.equal(pollIdFor(entry, '2026-10-04'), null);
  assert.equal(pollIdFor(entry, 'invalid'), null);
  assert.equal(pollIdFor({ ...entry, status: 'missed' }, '2026-10-08'), ID);
});

test('disabled configuration is explicit and HTTPS service paths are normalized', () => {
  assert.deepEqual(validateVotingConfig({ apiBaseUrl: null }, 'https://minutechreview.github.io/codex-28/'), { apiBaseUrl: null });
  assert.deepEqual(validateVotingConfig({ apiBaseUrl: 'https://votes.example.test/api/' }, 'https://minutechreview.github.io/codex-28/'), { apiBaseUrl: 'https://votes.example.test/api' });
});

test('HTTP loopback is available solely on a loopback development page', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(validateVotingConfig({ apiBaseUrl: `http://${host}:8787/` }, 'http://127.0.0.1:4173').apiBaseUrl, `http://${host}:8787`);
  }
  assert.throws(() => validateVotingConfig({ apiBaseUrl: 'http://127.0.0.1:8787' }, 'https://minutechreview.github.io/codex-28/'));
  assert.throws(() => validateVotingConfig({ apiBaseUrl: 'http://votes.example.test' }, 'http://localhost:4173'));
});

test('configuration rejects insecure, credentialed, ambiguous, relative and malformed URLs', () => {
  for (const config of [null, [], {}, { apiBaseUrl: null, extra: true }, { apiBaseUrl: 42 },
    ...['http://votes.example.test', 'javascript:alert(1)', '/api', 'https://user:pass@votes.example.test',
      'https://votes.example.test?key=secret', 'https://votes.example.test/#hash',
      ' https://votes.example.test', 'https://votes.exam\nple.test'].map((apiBaseUrl) => ({ apiBaseUrl }))]) {
    assert.throws(() => validateVotingConfig(config, 'https://minutechreview.github.io/codex-28/'));
  }
});

test('browser identity stores only one random identifier and survives reload', () => {
  const storage = memoryStorage();
  const first = browserIdentity(storage, { randomUUID: () => UUID });
  assert.deepEqual(first, identity);
  assert.deepEqual([...storage.values], [[VOTER_STORAGE_KEY, UUID]]);
  const reloaded = browserIdentity(storage, { randomUUID: () => { throw new Error('must reuse saved ID'); } });
  assert.deepEqual(reloaded, identity);
});

test('invalid saved browser identity is replaced with a valid random identifier', () => {
  const storage = memoryStorage({ [VOTER_STORAGE_KEY]: 'tampered' });
  assert.deepEqual(browserIdentity(storage, { randomUUID: () => UUID }), identity);
  assert.equal(storage.getItem(VOTER_STORAGE_KEY), UUID);
});

test('blocked, silently dropped, or unavailable identity persistence disables voting', () => {
  const unavailable = { voterId: null, available: false };
  assert.deepEqual(browserIdentity({ getItem() { throw new Error('blocked'); } }, { randomUUID: () => UUID }), unavailable);
  assert.deepEqual(browserIdentity({ getItem: () => null, setItem() { throw new Error('blocked'); } }, { randomUUID: () => UUID }), unavailable);
  assert.deepEqual(browserIdentity({ getItem: () => null, setItem() {} }, { randomUUID: () => UUID }), unavailable);
  assert.deepEqual(browserIdentity(memoryStorage(), {}), unavailable);
});

test('results require matching poll, finite integer counts, correct totals and a known choice', () => {
  assert.deepEqual(validatePollResult(result(), ID), result());
  for (const values of [{ pollId: SECOND_ID }, { approve: -1 }, { total: 4 }, { approve: '2' },
    { approve: 1.5 }, { total: Infinity }, { approve: Number.MAX_SAFE_INTEGER, notConvinced: 1, total: Number.MAX_SAFE_INTEGER + 1 },
    { yourVote: 'other' }, { yourVote: undefined }, { accepted: 'true' }, { approve: 0, notConvinced: 3, yourVote: 'approve' }]) {
    assert.throws(() => validatePollResult(result(ID, values), ID));
  }
});

test('percentage totals are readable and add to 100 after rounding', () => {
  assert.deepEqual(votePercentages(result()), { approve: 67, notConvinced: 33 });
  assert.deepEqual(votePercentages(result(ID, { approve: 0, notConvinced: 0, total: 0 })), { approve: 0, notConvinced: 0 });
});

test('configuration absent or failed never fetches or assumes zero counts', async () => {
  let calls = 0;
  const store = new PollStore({ fetchImpl: async () => { calls += 1; }, identity });
  await store.ensure(ID);
  store.setConfig({ apiBaseUrl: null });
  await store.refresh(ID);
  store.configFailed();
  await store.refresh(ID);
  assert.equal(calls, 0);
  assert.equal(store.state(ID).result, null);
});

test('GET obtains shared counts, queries the saved identity and omits credentials', async () => {
  const store = storeFor(async (url, options) => {
    const parsed = new URL(url);
    assert.equal(decodeURIComponent(parsed.pathname), `/polls/${ID}`);
    assert.equal(parsed.searchParams.get('voterId'), UUID);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    return response(result());
  });
  await store.ensure(ID);
  assert.equal(store.state(ID).phase, 'ready');
  assert.deepEqual(store.state(ID).result, result());
});

test('blocked storage still reads results but never submits an unremembered vote', async () => {
  let calls = 0;
  const store = storeFor(async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).searchParams.has('voterId'), false);
    assert.equal(options.method, 'GET');
    return response(result());
  }, { voterId: null, available: false });
  await store.ensure(ID);
  await store.vote(ID, 'approve');
  assert.equal(calls, 1);
  assert.deepEqual(store.state(ID).result, result());
});

test('vote waits for a readable poll, rejects unknown choices, and cannot be sent twice concurrently', async () => {
  const posted = deferred();
  let posts = 0;
  const store = storeFor(async (_url, options) => {
    if (options.method === 'GET') return response(result());
    posts += 1;
    assert.deepEqual(JSON.parse(options.body), { voterId: UUID, choice: 'approve' });
    return posted.promise;
  });
  await store.vote(ID, 'approve');
  assert.equal(posts, 0);
  assert.throws(() => store.vote(ID, 'invalid'), TypeError);
  await store.ensure(ID);
  const pending = store.vote(ID, 'approve');
  await store.vote(ID, 'not_convinced');
  const refreshing = store.refresh(ID);
  assert.equal(refreshing, pending);
  posted.resolve(response(result(ID, { approve: 3, total: 4, yourVote: 'approve', accepted: true })));
  await pending;
  await store.vote(ID, 'approve');
  assert.equal(posts, 1);
  assert.equal(store.state(ID).result.yourVote, 'approve');
});

test('duplicate server response keeps the original recorded choice with no optimistic increment', async () => {
  const store = storeFor(async (_url, options) => options.method === 'GET' ? response(result())
    : response(result(ID, { yourVote: 'not_convinced', accepted: false }), 409));
  await store.ensure(ID);
  await store.vote(ID, 'approve');
  assert.equal(store.state(ID).phase, 'ready');
  assert.deepEqual(store.state(ID).result, result(ID, { yourVote: 'not_convinced', accepted: false }));
});

test('lost POST response retains prior counts and allows only same-identity same-choice retry', async () => {
  let posts = 0;
  const requests = [];
  const store = storeFor(async (_url, options) => {
    if (options.method === 'GET') return response(result());
    posts += 1;
    requests.push(JSON.parse(options.body));
    if (posts === 1) throw new Error('response lost after save');
    return response(result(ID, { approve: 3, total: 4, yourVote: 'approve', accepted: false }));
  });
  await store.ensure(ID);
  await store.vote(ID, 'approve');
  assert.equal(store.state(ID).phase, 'vote-error');
  assert.equal(store.state(ID).result.total, 3);
  await store.vote(ID, 'not_convinced');
  assert.equal(posts, 1);
  await store.refresh(ID);
  assert.equal(store.state(ID).phase, 'vote-error');
  await store.vote(ID, 'approve');
  assert.equal(store.state(ID).phase, 'ready');
  assert.equal(store.state(ID).result.total, 4);
  assert.deepEqual(requests, [{ voterId: UUID, choice: 'approve' }, { voterId: UUID, choice: 'approve' }]);
});

test('GET after an ambiguous POST reconciles a server-saved vote without re-posting', async () => {
  let reads = 0;
  let posts = 0;
  const store = storeFor(async (_url, options) => {
    if (options.method === 'POST') { posts += 1; throw new Error('lost'); }
    reads += 1;
    return response(reads === 1 ? result() : result(ID, { approve: 3, total: 4, yourVote: 'approve' }));
  });
  await store.ensure(ID);
  await store.vote(ID, 'approve');
  await store.refresh(ID);
  assert.equal(store.state(ID).phase, 'ready');
  assert.equal(store.state(ID).attemptedChoice, null);
  await store.vote(ID, 'approve');
  assert.equal(posts, 1);
});

test('refresh recovers the recorded choice and preserves results while a refresh fails', async () => {
  let fail = false;
  const store = storeFor(async () => {
    if (fail) throw new Error('offline');
    return response(result(ID, { yourVote: 'approve' }));
  });
  await store.ensure(ID);
  fail = true;
  await store.refresh(ID);
  assert.equal(store.state(ID).phase, 'read-error');
  assert.deepEqual(store.state(ID).result, result(ID, { yourVote: 'approve' }));
  fail = false;
  await store.refresh(ID);
  assert.equal(store.state(ID).phase, 'ready');
  const reloaded = storeFor(async () => response(result(ID, { yourVote: 'approve' })));
  await reloaded.ensure(ID);
  assert.equal(reloaded.state(ID).result.yourVote, 'approve');
});

test('an initial GET failure never manufactures counts and can be retried', async () => {
  let fail = true;
  const store = storeFor(async () => fail ? response({}, 503) : response(result()));
  await store.ensure(ID);
  assert.equal(store.state(ID).phase, 'read-error');
  assert.equal(store.state(ID).result, null);
  fail = false;
  await store.refresh(ID);
  assert.equal(store.state(ID).phase, 'ready');
});

test('delayed results are isolated by poll ID when the visitor changes days', async () => {
  const first = deferred();
  const store = storeFor(async (url) => decodeURIComponent(new URL(url).pathname).endsWith(ID)
    ? first.promise : response(result(SECOND_ID, { approve: 8, notConvinced: 2, total: 10 })));
  const loadingFirst = store.ensure(ID);
  await store.ensure(SECOND_ID);
  first.resolve(response(result()));
  await loadingFirst;
  assert.equal(store.state(ID).result.total, 3);
  assert.equal(store.state(SECOND_ID).result.total, 10);
  await store.ensure(ID);
  assert.equal(store.state(ID).result.total, 3);
});

test('closed or unpublished backend polls disable submission until scoreboard refresh', async () => {
  for (const status of [404, 410]) {
    let posts = 0;
    const store = storeFor(async (_url, options) => { if (options.method === 'POST') posts += 1; return response({}, status); });
    await store.ensure(ID);
    await store.vote(ID, 'approve');
    assert.equal(store.state(ID).phase, 'closed');
    assert.equal(posts, 0);
  }
});

test('malformed and wrong-poll responses are rejected instead of contaminating shared results', async () => {
  for (const body of [result(SECOND_ID), result(ID, { total: 999 }), result(ID, { yourVote: 'invalid' })]) {
    const store = storeFor(async () => response(body));
    await store.ensure(ID);
    assert.equal(store.state(ID).phase, 'read-error');
    assert.equal(store.state(ID).result, null);
  }
});

test('POST must confirm its recorded choice and boolean acceptance', async () => {
  for (const body of [result(), result(ID, { accepted: true }),
    result(ID, { yourVote: 'not_convinced', accepted: true })]) {
    const store = storeFor(async (_url, options) => response(options.method === 'GET' ? result() : body));
    await store.ensure(ID);
    await store.vote(ID, 'approve');
    assert.equal(store.state(ID).phase, 'vote-error');
    assert.equal(store.state(ID).result.total, 3);
  }
});

test('abortable requests time out without a count or choice assumption', async () => {
  const store = new PollStore({ identity, timeoutMs: 5, fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  store.setConfig({ apiBaseUrl: 'https://votes.example.test' });
  await store.ensure(ID);
  assert.equal(store.state(ID).phase, 'read-error');
  assert.equal(store.state(ID).result, null);
});
