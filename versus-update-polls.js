// The existing daily update polls retain their endpoint, IDs, store, and browser ID.
import { PollStore, pollIdFor, browserIdentity, validateVotingConfig, votePercentages, VOTER_STORAGE_KEY } from './polls.js';

const choiceNames = { approve: 'Approve', not_convinced: 'Not convinced' };
const statusNames = { improvement: 'Improvement', reset: 'Reset', missed: 'Missed' };
const prettyDate = date => new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

/** One persistent store and reusable DOM nodes survive source/timeline re-renders. */
export class UpdatePolls {
  constructor({ fetchImpl = (...args) => fetch(...args), locks = globalThis.navigator?.locks, onReloadData = () => {} } = {}) {
    this.fetchImpl = fetchImpl;
    this.locks = locks;
    this.onReloadData = onReloadData;
    this.store = new PollStore({ fetchImpl, identity: { voterId: null, available: false } });
    this.hosts = new Map();
    this.configOperation = null;
    this.renderScheduled = false;
    this.store.subscribe(() => this.scheduleRender());
  }

  scheduleRender() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => { this.renderScheduled = false; this.renderVisible(); });
  }

  /** Load the original public configuration once; explicit failed-load retry is allowed. */
  loadConfig() {
    if (this.configOperation) return this.configOperation;
    if (this.store.configPhase === 'ready' || this.store.configPhase === 'unavailable') return Promise.resolve();
    this.store.configPhase = 'loading';
    this.store.emit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    this.configOperation = (async () => {
      try {
        const url = new URL('./voting-config.json', import.meta.url);
        url.searchParams.set('_', String(Date.now()));
        const response = await this.fetchImpl(url.href, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Voting configuration unavailable.');
        const config = validateVotingConfig(await response.json(), window.location.href);
        if (config.apiBaseUrl && !this.store.identity.available) {
          try {
            const initialize = () => browserIdentity(window.localStorage, window.crypto);
            // Both controllers serialize first-use UUID creation across tabs. Older
            // browsers retain the original update poll's storage-only behavior.
            this.store.identity = typeof this.locks?.request === 'function'
              ? await this.locks.request(VOTER_STORAGE_KEY, { mode: 'exclusive', signal: controller.signal }, initialize)
              : initialize();
          }
          catch { /* Unavailable storage or locks leave results read-only. */ }
        }
        this.store.setConfig(config);
      } catch { this.store.configFailed(); }
      finally { clearTimeout(timeout); this.configOperation = null; }
    })();
    return this.configOperation;
  }

  nodeFor(entry, currentDate) {
    const pollId = pollIdFor(entry, currentDate);
    if (!pollId) return null;
    let host = this.hosts.get(pollId);
    if (!host) {
      host = document.createElement('div');
      host.className = 'update-poll';
      host.dataset.pollId = pollId;
      host.id = `update-poll-day-${entry.day}`;
      // This is static markup only. Source and service values use textContent below.
      host.innerHTML = `<h4 id="${host.id}-title">Approve this update?</h4>
        <p class="update-poll-day" id="${host.id}-day"></p>
        <div class="update-poll-choices" role="group" aria-labelledby="${host.id}-title" aria-describedby="${host.id}-day">
          <button type="button" data-choice="approve" aria-pressed="false">Approve</button>
          <button type="button" data-choice="not_convinced" aria-pressed="false">Not convinced</button>
        </div>
        <div class="update-poll-results" hidden>
          <p class="update-poll-total"></p>
          <dl><div><dt>Approve</dt><dd class="update-poll-approve"></dd></div><div><dt>Not convinced</dt><dd class="update-poll-not-convinced"></dd></div></dl>
          <div class="update-poll-bar" aria-hidden="true"><span></span></div>
        </div>
        <p class="update-poll-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="update-poll-actions"><button type="button" class="update-poll-refresh">Refresh results</button><button type="button" class="update-poll-retry-vote" hidden></button></div>`;
      host.setAttribute('role', 'group');
      host.setAttribute('aria-labelledby', `${host.id}-title`);
      host.setAttribute('aria-describedby', `${host.id}-day`);
      for (const button of host.querySelectorAll('[data-choice]')) {
        button.addEventListener('click', () => this.store.vote(pollId, button.dataset.choice));
      }
      host.querySelector('.update-poll-refresh').addEventListener('click', () => {
        if (this.store.configPhase === 'error') this.loadConfig();
        else if (this.store.state(pollId).phase === 'closed') this.onReloadData();
        else this.store.refresh(pollId);
      });
      host.querySelector('.update-poll-retry-vote').addEventListener('click', () => {
        const choice = this.store.state(pollId).attemptedChoice;
        if (choice) this.store.vote(pollId, choice);
      });
      this.hosts.set(pollId, host);
    }
    host.querySelector('.update-poll-day').textContent = `Day ${entry.day} · ${prettyDate(entry.date)} · ${statusNames[entry.status]}`;
    this.renderNode(host);
    return host;
  }

  renderNode(host) {
    const state = this.store.state(host.dataset.pollId);
    const configured = this.store.configPhase === 'ready';
    const busy = configured && ['idle', 'loading', 'submitting'].includes(state.phase);
    host.setAttribute('aria-busy', String(busy));
    host.querySelector('.update-poll-choices').hidden = !configured || state.phase === 'closed';
    for (const button of host.querySelectorAll('[data-choice]')) {
      button.disabled = !configured || !this.store.identity.available || state.phase !== 'ready' || Boolean(state.result?.yourVote);
      button.setAttribute('aria-pressed', String(state.result?.yourVote === button.dataset.choice));
    }
    const results = host.querySelector('.update-poll-results');
    results.hidden = !configured || !state.result || state.phase === 'closed';
    if (!results.hidden) {
      const result = state.result;
      const percentages = votePercentages(result);
      host.querySelector('.update-poll-total').textContent = `${result.total.toLocaleString('en-US')} vote${result.total === 1 ? '' : 's'} · ${state.phase === 'ready' ? 'shared results' : 'last loaded results'}`;
      host.querySelector('.update-poll-approve').textContent = `${result.approve.toLocaleString('en-US')} · ${percentages.approve}%`;
      host.querySelector('.update-poll-not-convinced').textContent = `${result.notConvinced.toLocaleString('en-US')} · ${percentages.notConvinced}%`;
      host.querySelector('.update-poll-bar span').style.width = `${percentages.approve}%`;
    }
    let message;
    if (this.store.configPhase === 'loading') message = 'Loading update voting…';
    else if (this.store.configPhase === 'unavailable') message = 'COMING SOON · Update voting is not configured.';
    else if (this.store.configPhase === 'error') message = 'Update voting could not be loaded. Please try again.';
    else if (state.phase === 'closed') message = 'This update is not open for voting. Refresh the source records.';
    else if (state.phase === 'idle' || state.phase === 'loading') message = state.result ? 'Refreshing shared results…' : 'Loading shared results…';
    else if (state.phase === 'submitting') message = `Saving your ${choiceNames[state.attemptedChoice]} vote…`;
    else if (state.phase === 'read-error') message = state.result ? 'Refresh failed. Last loaded results shown. Please try again.' : 'Shared results could not be loaded. Please try again.';
    else if (state.phase === 'vote-error') message = state.errorStatus === 429 ? 'Voting is busy. Retry the same vote in a moment.' : 'Vote unconfirmed; it may have saved. Check status or retry the same vote.';
    else if (!this.store.identity.available) message = 'Shared results are available. Enable browser storage and reload to vote.';
    else if (state.result?.yourVote) message = `Your vote: ${choiceNames[state.result.yourVote]}.`;
    else message = state.result?.total ? 'How do you feel about this update?' : 'No votes yet. How do you feel about this update?';
    host.querySelector('.update-poll-status').textContent = message;
    const refresh = host.querySelector('.update-poll-refresh');
    refresh.hidden = ['loading', 'unavailable'].includes(this.store.configPhase);
    refresh.disabled = busy;
    refresh.textContent = this.store.configPhase === 'error' ? 'Try loading voting' : state.phase === 'closed' ? 'Refresh source records' : state.phase === 'vote-error' ? 'Check vote status' : state.phase === 'read-error' ? 'Try again' : 'Refresh results';
    const retryVote = host.querySelector('.update-poll-retry-vote');
    retryVote.hidden = !configured || state.phase !== 'vote-error' || !state.attemptedChoice;
    retryVote.textContent = state.attemptedChoice ? `Retry my ${choiceNames[state.attemptedChoice]} vote` : '';
  }

  renderVisible() {
    const visible = [...this.hosts.values()].filter(host => host.isConnected);
    for (const host of visible) this.renderNode(host);
    if (this.store.configPhase === 'ready') for (const host of visible) this.store.ensure(host.dataset.pollId);
  }

  refreshVisible() {
    for (const host of this.hosts.values()) if (host.isConnected) this.store.refresh(host.dataset.pollId);
  }
}
