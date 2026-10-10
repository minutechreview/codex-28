import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdatePolls } from '../versus-update-polls.js';
import { VOTER_STORAGE_KEY } from '../polls.js';
import { VersusPollStore } from '../versus-poll.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ID = 'codex-28:2026-10-05:day-1';
const config = { apiBaseUrl: 'https://votes.example.test' };
const response = raw => ({ ok: true, json: async () => raw });

function browser(t, { blocked = false, empty = false } = {}) {
  const previous = globalThis.window;
  const values = new Map(empty ? [] : [[VOTER_STORAGE_KEY, UUID]]);
  globalThis.window = {
    location: { href: 'https://tracker.example.test/' },
    localStorage: {
      getItem(key) { if (blocked) throw new Error('Storage blocked'); return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); },
    },
    crypto: { randomUUID() { throw new Error('Existing identity must be reused'); } },
  };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  return values;
}

test('concurrent update configuration loads share one request and reuse the existing browser identity', async t => {
  const values = browser(t);
  let resolve, requests = 0;
  const pending = new Promise(r => { resolve = r; });
  const polls = new UpdatePolls({ fetchImpl: async (url, options) => {
    requests++;
    assert.equal(new URL(url).pathname.endsWith('/voting-config.json'), true);
    assert.equal(options.cache, 'no-store');
    return pending;
  } });
  const first = polls.loadConfig();
  assert.equal(polls.loadConfig(), first);
  resolve(response(config));
  await first;
  await polls.loadConfig();
  assert.equal(requests, 1);
  assert.equal(polls.store.configPhase, 'ready');
  assert.deepEqual(polls.store.identity, { voterId: UUID, available: true });
  assert.deepEqual([...values], [[VOTER_STORAGE_KEY, UUID]]);
});

test('a failed update configuration can be retried without replacing existing poll history', async t => {
  browser(t);
  let requests = 0;
  const polls = new UpdatePolls({ fetchImpl: async () => response(++requests === 1 ? { ...config, unexpected: true } : config) });
  const history = polls.store.state(ID);
  history.result = { pollId: ID, approve: 2, notConvinced: 1, total: 3, yourVote: 'approve' };
  history.phase = 'ready';
  await polls.loadConfig();
  assert.equal(polls.store.configPhase, 'error');
  await polls.loadConfig();
  assert.equal(polls.store.configPhase, 'ready');
  assert.equal(polls.store.state(ID), history);
  assert.equal(history.result.yourVote, 'approve');
  assert.equal(requests, 2);
});

test('blocked browser storage leaves update polls read-only and unavailable configuration never allocates an identity', async t => {
  browser(t, { blocked: true });
  const polls = new UpdatePolls({ fetchImpl: async () => response(config) });
  await polls.loadConfig();
  assert.equal(polls.store.configPhase, 'ready');
  assert.deepEqual(polls.store.identity, { voterId: null, available: false });
  const unconfigured = new UpdatePolls({ fetchImpl: async () => response({ apiBaseUrl: null }) });
  await unconfigured.loadConfig();
  assert.equal(unconfigured.store.configPhase, 'unavailable');
  assert.deepEqual(unconfigured.store.identity, { voterId: null, available: false });
});

test('fresh update and team controllers serialize identity initialization and share exactly one UUID', async t => {
  const values = browser(t, { empty: true });
  let generated = 0, releaseRead, readStarted;
  const reading = new Promise(resolve => { readStarted = resolve; });
  const readResult = new Promise(resolve => { releaseRead = resolve; });
  const cryptoImpl = { randomUUID() { generated++; return UUID; } };
  window.crypto = cryptoImpl;
  const requests = [], tails = new Map();
  const locks = {
    request(key, options, callback) {
      requests.push({ key, mode: options.mode });
      const next = (tails.get(key) ?? Promise.resolve()).then(callback);
      tails.set(key, next.catch(() => {}));
      return next;
    },
  };
  const team = new VersusPollStore({
    storage: window.localStorage, cryptoImpl, locks, now: () => new Date('2026-10-10T18:00:00Z'),
    fetchImpl: async url => {
      assert.equal(new URL(url).searchParams.get('voterId'), UUID);
      readStarted();
      return readResult;
    },
  });
  team.setConfig(config);
  const teamLoad = team.load();
  await reading; // The team controller holds the shared identity lock through this read.
  const updates = new UpdatePolls({ locks, fetchImpl: async () => response(config) });
  let updatesSettled = false;
  const updatesLoad = updates.loadConfig().then(() => { updatesSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updatesSettled, false, 'update identity must wait for the team controller lock');
  assert.deepEqual(requests, [
    { key: VOTER_STORAGE_KEY, mode: 'exclusive' },
    { key: VOTER_STORAGE_KEY, mode: 'exclusive' },
  ]);
  releaseRead(response({ day: '2026-10-10', open: true, dotsVotes: 0, botsVotes: 0, totalVotes: 0, yourVote: null }));
  await Promise.all([teamLoad, updatesLoad]);
  assert.equal(generated, 1);
  assert.equal(values.get(VOTER_STORAGE_KEY), UUID);
  assert.deepEqual(updates.store.identity, team.identity);
  assert.equal(updates.store.configPhase, 'ready');
  assert.equal(team.phase, 'ready');
});

test('an available but rejected identity lock leaves update polls read-only without unsafe fallback', async t => {
  browser(t, { empty: true });
  let generated = 0;
  window.crypto = { randomUUID() { generated++; return UUID; } };
  const updates = new UpdatePolls({
    fetchImpl: async () => response(config),
    locks: { async request() { throw new Error('Lock unavailable'); } },
  });
  await updates.loadConfig();
  assert.equal(updates.store.configPhase, 'ready');
  assert.deepEqual(updates.store.identity, { voterId: null, available: false });
  assert.equal(generated, 0);
});
