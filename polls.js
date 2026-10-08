// Counts and recorded choices come only from the shared voting service.
// Browser storage holds a random identifier, never an authoritative vote count.
export const VOTER_STORAGE_KEY = 'codex-28-voter-id-v1';
export const VOTE_CHOICES = Object.freeze(['approve', 'not_convinced']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function realDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Text/status edits retain the poll. Future and unpublished days have no poll. */
export function pollIdFor(entry, currentDate) {
  if (!entry || !Number.isInteger(entry.day) || entry.day < 1 || entry.day > 28
    || !realDate(entry.date) || !realDate(currentDate) || entry.date > currentDate
    || !['improvement', 'reset', 'missed'].includes(entry.status)) return null;
  return `codex-28:${entry.date}:day-${entry.day}`;
}

/** HTTP is permitted only between loopback addresses during local development. */
export function validateVotingConfig(raw, pageUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'apiBaseUrl')) {
    throw new TypeError('Invalid voting configuration.');
  }
  if (raw.apiBaseUrl === null) return Object.freeze({ apiBaseUrl: null });
  if (typeof raw.apiBaseUrl !== 'string' || raw.apiBaseUrl.length > 2048
    || raw.apiBaseUrl.trim() !== raw.apiBaseUrl || /\s/.test(raw.apiBaseUrl)) {
    throw new TypeError('Invalid voting service URL.');
  }
  const url = new URL(raw.apiBaseUrl);
  const page = new URL(pageUrl);
  const localHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
    && LOOPBACK.has(page.hostname) && ['http:', 'https:'].includes(page.protocol);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password
    || url.search || url.hash) throw new TypeError('Voting requires a secure service URL.');
  return Object.freeze({ apiBaseUrl: url.href.replace(/\/+$/, '') });
}

/** Fail closed if an identifier cannot be reliably saved on this device. */
export function browserIdentity(storage, cryptoImpl) {
  try {
    const previous = storage.getItem(VOTER_STORAGE_KEY);
    if (previous && UUID.test(previous)) return Object.freeze({ voterId: previous.toLowerCase(), available: true });
    const voterId = cryptoImpl.randomUUID().toLowerCase();
    if (!UUID.test(voterId)) throw new Error('Invalid browser identifier.');
    storage.setItem(VOTER_STORAGE_KEY, voterId);
    if (storage.getItem(VOTER_STORAGE_KEY) !== voterId) throw new Error('Identifier was not saved.');
    return Object.freeze({ voterId, available: true });
  } catch {
    return Object.freeze({ voterId: null, available: false });
  }
}

export function validatePollResult(raw, pollId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.pollId !== pollId
    || ![raw.approve, raw.notConvinced, raw.total].every((value) => Number.isSafeInteger(value) && value >= 0)
    || !Number.isSafeInteger(raw.approve + raw.notConvinced) || raw.approve + raw.notConvinced !== raw.total
    || !(raw.yourVote === null || VOTE_CHOICES.includes(raw.yourVote))
    || (Object.hasOwn(raw, 'accepted') && typeof raw.accepted !== 'boolean')) {
    throw new TypeError('Invalid shared voting results.');
  }
  if (raw.yourVote === 'approve' && raw.approve === 0
    || raw.yourVote === 'not_convinced' && raw.notConvinced === 0) {
    throw new TypeError('Inconsistent shared voting results.');
  }
  return Object.freeze({ pollId, approve: raw.approve, notConvinced: raw.notConvinced,
    total: raw.total, yourVote: raw.yourVote,
    ...(Object.hasOwn(raw, 'accepted') ? { accepted: raw.accepted } : {}) });
}

export function votePercentages(result) {
  const approve = result.total ? Math.round(result.approve / result.total * 100) : 0;
  return { approve, notConvinced: result.total ? 100 - approve : 0 };
}

export class PollRequestError extends Error {
  constructor(status = 0) {
    super('The voting service could not confirm the request.');
    this.name = 'PollRequestError';
    this.status = status;
  }
}

/** Each poll owns its in-flight request and cached result; day changes cannot mix them. */
export class PollStore {
  constructor({ fetchImpl, identity, timeoutMs = 10000 }) {
    this.fetchImpl = fetchImpl;
    this.identity = identity;
    this.timeoutMs = timeoutMs;
    this.config = null;
    this.configPhase = 'loading';
    this.polls = new Map();
    this.listeners = new Set();
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(); }
  setConfig(config) { this.config = config; this.configPhase = config.apiBaseUrl ? 'ready' : 'unavailable'; this.emit(); }
  configFailed() { this.configPhase = 'error'; this.emit(); }
  state(pollId) {
    if (!this.polls.has(pollId)) this.polls.set(pollId, {
      phase: 'idle', result: null, attemptedChoice: null, errorStatus: null, operation: null,
    });
    return this.polls.get(pollId);
  }

  async request(pollId, choice = null) {
    const url = new URL(`${this.config.apiBaseUrl}/polls/${encodeURIComponent(pollId)}`);
    if (!choice && this.identity.available) url.searchParams.set('voterId', this.identity.voterId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.href, {
        method: choice ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal,
        ...(choice ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voterId: this.identity.voterId, choice }) } : {}),
      });
      if (!response.ok && response.status !== 409) throw new PollRequestError(response.status);
      const result = validatePollResult(await response.json(), pollId);
      if (!response.ok && !(choice && response.status === 409 && result.accepted === false && result.yourVote)) {
        throw new PollRequestError(response.status);
      }
      if (choice && (typeof result.accepted !== 'boolean' || !result.yourVote)) {
        throw new TypeError('The service did not confirm a recorded choice.');
      }
      if (choice && result.accepted && result.yourVote !== choice) {
        throw new TypeError('The service confirmed a different choice.');
      }
      return result;
    } finally { clearTimeout(timeout); }
  }

  ensure(pollId) {
    if (this.state(pollId).phase === 'idle') return this.refresh(pollId);
    return this.state(pollId).operation;
  }

  refresh(pollId) {
    const state = this.state(pollId);
    if (this.configPhase !== 'ready') return Promise.resolve();
    if (['loading', 'submitting'].includes(state.phase)) return state.operation;
    state.phase = 'loading';
    state.errorStatus = null;
    state.operation = this.request(pollId).then((result) => {
      state.result = result;
      // A lost POST response may still be in flight. Keep retries on the same choice
      // until the server confirms a vote, even if a subsequent GET shows no choice.
      if (result.yourVote) state.attemptedChoice = null;
      state.phase = state.attemptedChoice ? 'vote-error' : 'ready';
    }).catch((error) => {
      state.errorStatus = error.status || 0;
      state.phase = [404, 410].includes(error.status) ? 'closed' : state.attemptedChoice ? 'vote-error' : 'read-error';
    }).finally(() => { state.operation = null; this.emit(); });
    this.emit();
    return state.operation;
  }

  vote(pollId, choice) {
    if (!VOTE_CHOICES.includes(choice)) throw new TypeError('Unknown vote choice.');
    const state = this.state(pollId);
    if (this.configPhase !== 'ready' || !this.identity.available || !state.result
      || state.result.yourVote || !['ready', 'vote-error'].includes(state.phase)
      || (state.attemptedChoice && state.attemptedChoice !== choice)) return Promise.resolve();
    state.attemptedChoice = choice;
    state.phase = 'submitting';
    state.errorStatus = null;
    state.operation = this.request(pollId, choice).then((result) => {
      state.result = result;
      state.attemptedChoice = null;
      state.phase = 'ready';
    }).catch((error) => {
      state.errorStatus = error.status || 0;
      state.phase = [404, 410].includes(error.status) ? 'closed' : 'vote-error';
    }).finally(() => { state.operation = null; this.emit(); });
    this.emit();
    return state.operation;
  }
}
