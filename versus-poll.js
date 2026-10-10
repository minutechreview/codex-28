// Proposed Supabase team poll. The existing Cloudflare approval poll is independent.
export const TEAM_CHOICES = Object.freeze(['dots', 'bots']);
export const SESSION_KEY = 'codex-28-versus-session-v1';
export const DAY_CHOICE_KEY = 'codex-28-versus-choice-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function validateVersusConfig(raw, pageUrl = globalThis.location?.href) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2
      || !Object.hasOwn(raw, 'supabaseUrl') || !Object.hasOwn(raw, 'publishableKey')) {
    throw new TypeError('Invalid team poll configuration.');
  }
  if (raw.supabaseUrl === null && raw.publishableKey === null) return Object.freeze({ ...raw });
  if (typeof raw.supabaseUrl !== 'string' || raw.supabaseUrl.trim() !== raw.supabaseUrl
      || /\s/.test(raw.supabaseUrl) || typeof raw.publishableKey !== 'string'
      || !/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(raw.publishableKey)) {
    throw new TypeError('Use only a public Supabase project URL and publishable key.');
  }
  const url = new URL(raw.supabaseUrl);
  const page = new URL(pageUrl);
  const hosted = url.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname);
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname) && LOOPBACK.has(page.hostname);
  if ((!hosted && !local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('Use a secure Supabase origin (or loopback for local testing).');
  }
  return Object.freeze({ supabaseUrl: url.origin, publishableKey: raw.publishableKey });
}

export function validateVersusResult(raw) {
  const realDay = typeof raw?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)
    && Number.isFinite(Date.parse(`${raw.day}T12:00:00Z`))
    && new Date(`${raw.day}T12:00:00Z`).toISOString().slice(0, 10) === raw.day;
  if (!raw || Array.isArray(raw) || !realDay || typeof raw.open !== 'boolean'
      || ![raw.dotsVotes, raw.botsVotes, raw.totalVotes].every(n => Number.isSafeInteger(n) && n >= 0)
      || !Number.isSafeInteger(raw.dotsVotes + raw.botsVotes)
      || raw.dotsVotes + raw.botsVotes !== raw.totalVotes
      || !(raw.yourVote === null || TEAM_CHOICES.includes(raw.yourVote))
      || (Object.hasOwn(raw, 'accepted') && typeof raw.accepted !== 'boolean')
      || (raw.yourVote === 'dots' && raw.dotsVotes === 0)
      || (raw.yourVote === 'bots' && raw.botsVotes === 0)) {
    throw new TypeError('The service returned invalid team poll results.');
  }
  return Object.freeze({ day: raw.day, open: raw.open, dotsVotes: raw.dotsVotes, botsVotes: raw.botsVotes,
    totalVotes: raw.totalVotes, yourVote: raw.yourVote,
    ...(Object.hasOwn(raw, 'accepted') ? { accepted: raw.accepted } : {}) });
}

export function votePercentages(result) {
  const dots = result.totalVotes ? Math.round(100 * result.dotsVotes / result.totalVotes) : 0;
  return { dots, bots: result.totalVotes ? 100 - dots : 0 };
}

export function voteHealth(result) {
  return {
    tiboHealth: 100 - (100 * result.botsVotes / Math.max(result.totalVotes, 1)) * 0.9,
    potetoHealth: 100 - (100 * result.dotsVotes / Math.max(result.totalVotes, 1)) * 0.9,
  };
}

export class VersusRequestError extends Error {
  constructor(status = 0, code = 'unconfirmed') {
    super('The team poll service could not confirm this request.');
    this.name = 'VersusRequestError'; this.status = status; this.code = code;
  }
}
class StorageError extends Error {}

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

function savedSession(raw) {
  if (!raw || !UUID.test(raw.userId) || !Number.isSafeInteger(raw.expiresAt)
      || !['accessToken', 'refreshToken'].every(key => typeof raw[key] === 'string'
        && raw[key].length > 0 && raw[key].length < 16384 && !/\s/.test(raw[key]))) {
    throw new StorageError('The saved anonymous identity needs attention.');
  }
  return raw;
}

/** Counts are server-owned. Local storage only retains identity and daily choice hints. */
export class VersusPollStore {
  constructor({ fetchImpl = globalThis.fetch, storage = defaultStorage(), locks = globalThis.navigator?.locks,
    now = () => new Date(), timeoutMs = 10000 } = {}) {
    this.fetchImpl = fetchImpl.bind(globalThis); this.storage = storage; this.locks = locks;
    this.now = now; this.timeoutMs = timeoutMs; this.config = null;
    this.phase = 'coming-soon'; this.result = null; this.pendingTeam = null;
    this.errorStatus = null; this.errorCode = null; this.operation = null; this.listeners = new Set();
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(); }
  setConfig(config) {
    this.config = config; this.phase = config.supabaseUrl ? 'idle' : 'coming-soon'; this.emit();
  }
  configFailed() { this.phase = 'read-error'; this.errorCode = 'configuration'; this.emit(); }
  get sessionKey() { return `${SESSION_KEY}:${this.config.supabaseUrl}`; }
  choiceKey(day) { return `${DAY_CHOICE_KEY}:${this.config.supabaseUrl}:${day}`; }
  readStorage(key) {
    try { return this.storage.getItem(key); } catch { throw new StorageError('Browser storage is unavailable.'); }
  }
  saveStorage(key, value) {
    try {
      this.storage.setItem(key, value);
      if (this.storage.getItem(key) !== value) throw new Error('Storage did not persist.');
    } catch { throw new StorageError('Browser storage is unavailable.'); }
  }
  readChoice(day) {
    const value = this.readStorage(this.choiceKey(day));
    if (!value) return null;
    try {
      const choice = JSON.parse(value);
      if (!TEAM_CHOICES.includes(choice.team) || !['pending', 'confirmed'].includes(choice.phase)) throw new Error();
      return choice;
    } catch { throw new StorageError('The saved daily choice is invalid.'); }
  }
  async request(path, body, accessToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.supabaseUrl}${path}`, {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', apikey: this.config.publishableKey,
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        let code = 'unconfirmed';
        try { code = (await response.json()).code || code; } catch { /* No untrusted server text in the UI. */ }
        throw new VersusRequestError(response.status, code);
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async withSession(callback) {
    // An anonymous identity must not split into two accounts when two tabs first open together.
    if (!this.storage || typeof this.locks?.request !== 'function') {
      throw new StorageError('Voting needs persistent browser storage and Web Locks.');
    }
    return this.locks.request(this.sessionKey, { mode: 'exclusive', signal: AbortSignal.timeout(this.timeoutMs) }, async () => {
      const raw = this.readStorage(this.sessionKey);
      let session;
      if (raw) {
        try { session = savedSession(JSON.parse(raw)); } catch { throw new StorageError('The saved identity is invalid.'); }
      }
      if (!session || session.expiresAt <= Math.floor(this.now().getTime() / 1000) + 60) {
        // Verify persistence before making a signup request. Never replace a failed/expired identity.
        this.saveStorage(`${this.sessionKey}:storage-check`, '1');
        session = await this.refreshSession(session);
      }
      return callback(session);
    });
  }
  async refreshSession(previous) {
    const refreshed = await this.request(previous ? '/auth/v1/token?grant_type=refresh_token' : '/auth/v1/signup',
      previous ? { refresh_token: previous.refreshToken } : { data: {} });
    const expiry = refreshed.expires_at ?? Math.floor(this.now().getTime() / 1000) + refreshed.expires_in;
    const next = savedSession({ userId: refreshed.user?.id, accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token, expiresAt: expiry });
    if (previous && next.userId !== previous.userId) throw new VersusRequestError(0, 'identity_changed');
    this.saveStorage(this.sessionKey, JSON.stringify(next)); return next;
  }
  async rpc(path, body, session) {
    try { return await this.request(path, body, session.accessToken); }
    catch (error) {
      if (error.status !== 401) throw error;
      // A skewed browser clock must not strand a still-refreshable identity. Retry once only.
      const refreshed = await this.refreshSession(session);
      return this.request(path, body, refreshed.accessToken);
    }
  }
  reconcile(result) {
    this.result = result;
    if (result.yourVote) {
      this.saveStorage(this.choiceKey(result.day), JSON.stringify({ team: result.yourVote, phase: 'confirmed' }));
      this.pendingTeam = null;
    } else {
      const local = this.readChoice(result.day);
      this.pendingTeam = local?.team ?? null;
      if (local?.phase === 'confirmed') this.errorCode = 'device_already_voted';
    }
    this.phase = !result.open ? 'closed' : this.pendingTeam ? 'vote-error' : 'ready';
  }
  failed(error, voting = false) {
    this.errorStatus = error.status || 0; this.errorCode = error.code || null;
    this.phase = error instanceof StorageError ? 'storage-error'
      : error.code === 'P0001' ? 'closed' : voting ? 'vote-error' : 'read-error';
  }
  load() { return this.refresh(); }
  refresh() {
    if (!this.config?.supabaseUrl) return Promise.resolve();
    if (this.operation) return this.operation;
    this.phase = 'loading'; this.errorStatus = null; this.errorCode = null;
    this.operation = this.withSession(async session => {
      this.reconcile(validateVersusResult(await this.rpc('/rest/v1/rpc/versus_results', {}, session)));
    }).catch(error => this.failed(error)).finally(() => { this.operation = null; this.emit(); });
    this.emit(); return this.operation;
  }
  vote(team) {
    if (!TEAM_CHOICES.includes(team)) throw new TypeError('Choose TEAM DOTS or TEAM BOTS.');
    if (!this.config?.supabaseUrl || !this.result?.open || this.result.yourVote || this.operation
        || !['ready', 'vote-error'].includes(this.phase) || (this.pendingTeam && this.pendingTeam !== team)) {
      return this.operation ?? Promise.resolve();
    }
    const day = this.result.day;
    this.phase = 'submitting'; this.pendingTeam = team; this.errorStatus = null; this.errorCode = null;
    this.operation = this.withSession(async session => {
      const local = this.readChoice(day);
      if (local?.phase === 'confirmed') {
        this.reconcile(validateVersusResult(await this.rpc('/rest/v1/rpc/versus_results', {}, session)));
        return;
      }
      if (local && local.team !== team) {
        this.pendingTeam = local.team;
        throw new VersusRequestError(0, 'choice_pending');
      }
      this.saveStorage(this.choiceKey(day), JSON.stringify({ team, phase: 'pending' }));
      const result = validateVersusResult(await this.rpc('/rest/v1/rpc/cast_versus_vote',
        { p_team: team, p_expected_day: day }, session));
      if (result.day !== day || typeof result.accepted !== 'boolean' || !result.yourVote
          || (result.accepted && result.yourVote !== team)) throw new VersusRequestError(0, 'invalid_confirmation');
      this.reconcile(result);
    }).catch(error => this.failed(error, true)).finally(() => { this.operation = null; this.emit(); });
    this.emit(); return this.operation;
  }
}
