// LOCAL TEST ONLY: SQLite models uniqueness; JS models the proposed auth/RLS/RPC contract.
// This is not an emulator for Postgres RLS or a claim that proposal.sql was deployed.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const MOCK_CONFIG = { supabaseUrl: 'https://versus-test.supabase.co', publishableKey: 'sb_publishable_mockabcdefghijklmnop' };
export class SupabaseContractMock {
  constructor(now = '2026-10-10T20:00:00Z') {
    this.now = new Date(now); this.signups = 0; this.voteRequests = 0; this.readRequests = 0;
    this.ip = 'mock-ip'; this.signupTimes = new Map(); this.sessions = new Map(); this.refreshTokens = new Map();
    this.failReads = false; this.loseNextVote = false;
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`CREATE TABLE votes(vote_day TEXT NOT NULL, voter_id TEXT NOT NULL,
      team TEXT NOT NULL CHECK(team IN ('dots','bots')), PRIMARY KEY(vote_day,voter_id))`);
    this.fetch = this.fetch.bind(this);
  }
  close() { this.db.close(); }
  day() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now);
  }
  open() { return this.day() >= '2026-10-05' && this.day() <= '2026-11-01'; }
  newSession(uid = randomUUID()) {
    const access = `mock-access-${randomUUID()}`; const refresh = `mock-refresh-${randomUUID()}`;
    this.sessions.set(access, { uid, expiresAt: this.now.getTime() + 3600000 }); this.refreshTokens.set(refresh, uid);
    return { access_token: access, refresh_token: refresh,
      expires_at: Math.floor(this.now.getTime() / 1000) + 3600, user: { id: uid } };
  }
  results(uid) {
    const counts = this.db.prepare(`SELECT sum(team='dots') AS dots, sum(team='bots') AS bots,
      max(CASE WHEN voter_id=? THEN team END) AS own FROM votes WHERE vote_day=?`).get(uid, this.day());
    const dotsVotes = counts.dots ?? 0; const botsVotes = counts.bots ?? 0;
    return { day: this.day(), open: this.open(), dotsVotes, botsVotes, totalVotes: dotsVotes + botsVotes,
      yourVote: counts.own ?? null };
  }
  async fetch(url, init = {}) {
    const path = new URL(url).pathname; const headers = new Headers(init.headers);
    const error = (status, code) => Response.json({ code }, { status });
    if (new URL(url).origin !== MOCK_CONFIG.supabaseUrl || init.method !== 'POST'
        || headers.get('apikey') !== MOCK_CONFIG.publishableKey) return error(403, '42501');
    let body;
    try { body = JSON.parse(init.body); } catch { return error(400, '22023'); }
    if (!body || Array.isArray(body) || typeof body !== 'object') return error(400, '22023');
    if (path === '/auth/v1/signup') {
      // Model the documented Auth IP limit separately from the row uniqueness guard.
      const recent = (this.signupTimes.get(this.ip) || []).filter(at => at > this.now.getTime() - 3600000);
      if (recent.length >= 30) return error(429, 'over_request_rate_limit');
      recent.push(this.now.getTime()); this.signupTimes.set(this.ip, recent); this.signups++;
      return Response.json(this.newSession());
    }
    if (path === '/auth/v1/token') {
      const uid = this.refreshTokens.get(body.refresh_token);
      if (!uid) return error(400, 'refresh_token_not_found');
      this.refreshTokens.delete(body.refresh_token);
      return Response.json(this.newSession(uid));
    }
    const session = this.sessions.get(headers.get('Authorization')?.replace(/^Bearer /, ''));
    if (!session) return error(403, '42501');
    if (this.now.getTime() >= session.expiresAt) return error(401, 'PGRST301');
    const uid = session.uid;
    if (path === '/rest/v1/rpc/versus_results') {
      this.readRequests++;
      if (Object.keys(body).length) return error(404, 'PGRST202');
      if (this.failReads) return error(503, 'unavailable');
      return Response.json(this.results(uid));
    }
    if (path !== '/rest/v1/rpc/cast_versus_vote') return error(404, 'PGRST202');
    this.voteRequests++;
    if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'p_team') || !Object.hasOwn(body, 'p_expected_day')) {
      return error(404, 'PGRST202');
    }
    if (!['dots', 'bots'].includes(body.p_team) || body.p_expected_day !== this.day()) return error(400, '22023');
    if (!this.open()) return error(400, 'P0001');
    const inserted = this.db.prepare('INSERT INTO votes(vote_day,voter_id,team) VALUES(?,?,?) ON CONFLICT(vote_day,voter_id) DO NOTHING')
      .run(this.day(), uid, body.p_team).changes === 1;
    if (this.loseNextVote) { this.loseNextVote = false; throw new Error('Mock response lost after commit'); }
    return Response.json({ ...this.results(uid), accepted: inserted });
  }
}

export function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
/** FIFO lock shared by separate mock tabs, matching the browser exclusive lock contract. */
export function mockLocks() {
  const queues = new Map();
  return { request(name, _options, callback) {
    const current = (queues.get(name) ?? Promise.resolve()).then(callback);
    queues.set(name, current.catch(() => {})); return current;
  } };
}
