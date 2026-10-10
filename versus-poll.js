// Daily team support uses isolated Worker/D1 routes. Approval polls stay independent.
import { browserIdentity, validateVotingConfig, VOTER_STORAGE_KEY } from './polls.js';
import { dateInTimezone } from './model.js';

export const TEAM_CHOICES = Object.freeze(['dots', 'bots']);
export const DAY_CHOICE_KEY = 'codex-28-versus-choice-v1';
export const DEVICE_LOCK_KEY = VOTER_STORAGE_KEY;
const PACIFIC_TIMEZONE = 'America/Los_Angeles';

/** The same safe URL validation as the existing update polls; null stays COMING SOON. */
export function validateVersusConfig(raw, pageUrl = globalThis.location?.href) {
  return validateVotingConfig(raw, pageUrl);
}

export function validateVersusResult(raw, expectedDay = null) {
  const realDay = typeof raw?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)
    && Number.isFinite(Date.parse(`${raw.day}T12:00:00Z`))
    && new Date(`${raw.day}T12:00:00Z`).toISOString().slice(0, 10) === raw.day;
  if (!raw || Array.isArray(raw) || !realDay || (expectedDay && raw.day !== expectedDay)
      || typeof raw.open !== 'boolean'
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

/** Counts are server-owned. Storage retains the existing UUID and daily choice hints only. */
export class VersusPollStore {
  constructor({ fetchImpl = globalThis.fetch, storage = defaultStorage(), locks = globalThis.navigator?.locks,
    cryptoImpl = globalThis.crypto, identity = null, now = () => new Date(), timeoutMs = 10000 } = {}) {
    this.fetchImpl = fetchImpl.bind(globalThis); this.storage = storage; this.locks = locks;
    this.cryptoImpl = cryptoImpl; this.identity = identity; this.now = now; this.timeoutMs = timeoutMs;
    this.config = null; this.configVersion = 0;
    this.phase = 'coming-soon'; this.result = null; this.pendingTeam = null;
    this.errorStatus = null; this.errorCode = null; this.operation = null; this.listeners = new Set();
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(); }
  setIdentity(identity) { this.identity = identity; }
  setConfig(config, identity = this.identity) {
    this.configVersion += 1; this.config = config; this.identity = identity;
    this.phase = config.apiBaseUrl ? 'idle' : 'coming-soon';
    this.result = null; this.pendingTeam = null; this.errorStatus = null; this.errorCode = null; this.emit();
  }
  configure(config, identity = this.identity) { this.setConfig(config, identity); }
  configFailed() { this.phase = 'read-error'; this.errorCode = 'configuration'; this.emit(); }
  currentDay() { return dateInTimezone(this.now(), PACIFIC_TIMEZONE); }
  choiceKey(day, config = this.config) { return `${DAY_CHOICE_KEY}:${config.apiBaseUrl}:${day}`; }
  readStorage(key) {
    try { return this.storage.getItem(key); } catch { throw new StorageError('Browser storage is unavailable.'); }
  }
  saveStorage(key, value) {
    try {
      this.storage.setItem(key, value);
      if (this.storage.getItem(key) !== value) throw new Error('Storage did not persist.');
    } catch { throw new StorageError('Browser storage is unavailable.'); }
  }
  readChoice(day, config = this.config) {
    const value = this.readStorage(this.choiceKey(day, config));
    if (!value) return null;
    try {
      const choice = JSON.parse(value);
      if (!choice || Object.keys(choice).length !== 2 || !TEAM_CHOICES.includes(choice.team)
          || !['pending', 'confirmed'].includes(choice.phase)) throw new Error();
      return choice;
    } catch { throw new StorageError('The saved daily choice is invalid.'); }
  }
  async withIdentity(callback) {
    if (!this.storage || typeof this.locks?.request !== 'function') {
      throw new StorageError('Voting needs persistent browser storage and Web Locks.');
    }
    return this.locks.request(DEVICE_LOCK_KEY, { mode: 'exclusive', signal: AbortSignal.timeout(this.timeoutMs) }, async () => {
      const identity = browserIdentity(this.storage, this.cryptoImpl);
      if (!identity.available || (this.identity && (!this.identity.available || this.identity.voterId !== identity.voterId))) {
        throw new StorageError('The saved browser identity is unavailable or changed.');
      }
      this.identity = identity;
      return callback(identity);
    });
  }
  async request(day, identity, choice = null, config = this.config) {
    const url = new URL(`${config.apiBaseUrl}/teams/${encodeURIComponent(day)}`);
    if (!choice) url.searchParams.set('voterId', identity.voterId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.href, {
        method: choice ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        ...(choice ? { headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voterId: identity.voterId, choice }) } : {}),
      });
      if (!response.ok && response.status !== 409) {
        let code = 'unconfirmed';
        try {
          const error = await response.json();
          const candidate = typeof error.error === 'string' ? error.error : error.error?.code;
          if (typeof candidate === 'string' && /^[a-z_]{1,80}$/i.test(candidate)) code = candidate;
        } catch { /* No untrusted server message is rendered. */ }
        throw new VersusRequestError(response.status, code);
      }
      const result = validateVersusResult(await response.json(), day);
      if (!response.ok && !(choice && response.status === 409 && result.accepted === false && result.yourVote)) {
        throw new VersusRequestError(response.status);
      }
      if (choice && (!result.open || typeof result.accepted !== 'boolean' || !result.yourVote
          || (result.accepted && result.yourVote !== choice))) {
        throw new VersusRequestError(0, 'invalid_confirmation');
      }
      return result;
    } finally { clearTimeout(timeout); }
  }
  reconcile(result, config = this.config) {
    this.result = result; this.errorStatus = null; this.errorCode = null;
    if (result.yourVote) {
      this.saveStorage(this.choiceKey(result.day, config), JSON.stringify({ team: result.yourVote, phase: 'confirmed' }));
      this.pendingTeam = null;
    } else {
      const local = this.readChoice(result.day, config);
      this.pendingTeam = local?.team ?? null;
      if (local?.phase === 'confirmed') this.errorCode = 'device_already_voted';
    }
    this.phase = !result.open ? 'closed' : this.pendingTeam ? 'vote-error' : 'ready';
  }
  failed(error, voting = false) {
    this.errorStatus = error.status || 0; this.errorCode = error.code || null;
    this.phase = error instanceof StorageError ? 'storage-error'
      : [404, 410].includes(error.status) ? 'closed' : voting || this.pendingTeam ? 'vote-error' : 'read-error';
  }
  async readCurrent(identity, config, version) {
    // A response crossing PT midnight never installs the previous day's counts.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (version !== this.configVersion) return;
      const day = this.currentDay();
      let result;
      try { result = await this.request(day, identity, null, config); }
      catch (error) {
        if (version !== this.configVersion) return;
        if (day !== this.currentDay()) continue;
        throw error;
      }
      if (version !== this.configVersion) return;
      if (day !== this.currentDay()) continue;
      this.reconcile(result, config); return;
    }
    throw new VersusRequestError(0, 'day_changed');
  }
  load() { return this.refresh(); }
  refresh() {
    if (!this.config?.apiBaseUrl) return Promise.resolve();
    if (this.operation) return this.operation;
    const config = this.config, version = this.configVersion;
    if (this.result && this.result.day !== this.currentDay()) { this.result = null; this.pendingTeam = null; }
    this.phase = 'loading'; this.errorStatus = null; this.errorCode = null;
    this.operation = this.withIdentity(identity => this.readCurrent(identity, config, version))
      .catch(error => { if (version === this.configVersion) this.failed(error); })
      .finally(() => { this.operation = null; this.emit(); });
    this.emit(); return this.operation;
  }
  vote(team) {
    if (!TEAM_CHOICES.includes(team)) throw new TypeError('Choose TEAM DOTS or TEAM BOTS.');
    if (this.config?.apiBaseUrl && !this.operation && this.result && this.result.day !== this.currentDay()) {
      return this.refresh();
    }
    if (!this.config?.apiBaseUrl || !this.result?.open || this.result.yourVote || this.operation
        || !['ready', 'vote-error'].includes(this.phase) || (this.pendingTeam && this.pendingTeam !== team)) {
      return this.operation ?? Promise.resolve();
    }
    const day = this.result.day;
    if (day !== this.currentDay()) return this.refresh();
    const config = this.config, version = this.configVersion;
    this.phase = 'submitting'; this.pendingTeam = team; this.errorStatus = null; this.errorCode = null;
    this.operation = this.withIdentity(async identity => {
      if (version !== this.configVersion) return;
      if (day !== this.currentDay()) {
        this.result = null; this.pendingTeam = null; await this.readCurrent(identity, config, version); return;
      }
      const local = this.readChoice(day, config);
      if (local?.phase === 'confirmed') { await this.readCurrent(identity, config, version); return; }
      if (local && local.team !== team) {
        this.pendingTeam = local.team; throw new VersusRequestError(0, 'choice_pending');
      }
      this.saveStorage(this.choiceKey(day, config), JSON.stringify({ team, phase: 'pending' }));
      let result;
      try { result = await this.request(day, identity, team, config); }
      catch (error) {
        if (version === this.configVersion && day !== this.currentDay()) {
          this.result = null; this.pendingTeam = null; await this.readCurrent(identity, config, version); return;
        }
        throw error;
      }
      if (version !== this.configVersion) return;
      if (day !== this.currentDay()) {
        this.saveStorage(this.choiceKey(day, config), JSON.stringify({ team: result.yourVote, phase: 'confirmed' }));
        this.result = null; this.pendingTeam = null; await this.readCurrent(identity, config, version); return;
      }
      this.reconcile(result, config);
    }).catch(error => { if (version === this.configVersion) this.failed(error, true); })
      .finally(() => { this.operation = null; this.emit(); });
    this.emit(); return this.operation;
  }
}
