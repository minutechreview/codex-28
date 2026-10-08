import { validateData, getTrackerState, freshness } from './model.js';
import { pollIdFor, validateVotingConfig, browserIdentity, votePercentages, PollStore } from './polls.js';

const $ = (id) => document.getElementById(id);
const names = { improvement: 'Improvement', reset: 'Reset', pending: 'Waiting', missed: 'Missed' };
const icons = { improvement: '↑', reset: '↻', pending: '…', missed: '×' };
let currentData = null;
let selectedDay = null;
let loading = false;
let clockKey = '';
let votingConfigLoading = false;
const choiceNames = { approve: 'Approve', not_convinced: 'Not convinced' };
const polls = new PollStore({ fetchImpl: (...args) => fetch(...args), identity: { voterId: null, available: false } });

function renderPoll(host, entry, currentDate) {
  const pollId = pollIdFor(entry, currentDate);
  if (!pollId) {
    host.hidden = true;
    delete host.dataset.pollId;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  if (host.dataset.pollId !== pollId) {
    host.dataset.pollId = pollId;
    // Only static markup goes through innerHTML; all update/service text uses textContent.
    host.innerHTML = `<h4 class="poll-title" id="${host.id}-title">Approve this update?</h4>
      <p class="poll-day" id="${host.id}-day"></p>
      <div class="poll-choices" role="group" aria-labelledby="${host.id}-title" aria-describedby="${host.id}-day">
        <button type="button" class="vote-button" data-choice="approve" aria-pressed="false" aria-describedby="${host.id}-day">Approve</button>
        <button type="button" class="vote-button" data-choice="not_convinced" aria-pressed="false" aria-describedby="${host.id}-day">Not convinced</button>
      </div>
      <div class="poll-results" hidden>
        <p class="poll-total"></p>
        <dl class="poll-breakdown"><div><dt>Approve</dt><dd class="poll-approve"></dd></div><div><dt>Not convinced</dt><dd class="poll-not-convinced"></dd></div></dl>
        <div class="poll-bar" aria-hidden="true"><span></span></div>
      </div>
      <p class="poll-status" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="poll-actions"><button type="button" class="poll-refresh">Refresh results</button><button type="button" class="poll-retry-vote" hidden></button></div>
      <p class="poll-help">One vote per browser per day. A random ID is saved on this device to remember your vote. Clearing browser storage or using another browser can allow another vote. These are visitor opinions; only the site owner updates the scoreboard.</p>`;
    host.setAttribute('role', 'group');
    host.setAttribute('aria-labelledby', `${host.id}-title`);
    host.setAttribute('aria-describedby', `${host.id}-day`);
    for (const button of host.querySelectorAll('[data-choice]')) {
      button.addEventListener('click', () => polls.vote(pollId, button.dataset.choice));
    }
    host.querySelector('.poll-refresh').addEventListener('click', () => {
      if (polls.configPhase === 'error') loadVotingConfig();
      else if (polls.state(pollId).phase === 'closed') loadData();
      else polls.refresh(pollId);
    });
    host.querySelector('.poll-retry-vote').addEventListener('click', () => {
      const choice = polls.state(pollId).attemptedChoice;
      if (choice) polls.vote(pollId, choice);
    });
  }
  host.querySelector('.poll-day').textContent = `Day ${entry.day} · ${prettyDate(entry.date)} · ${names[entry.status]}`;
  const state = polls.state(pollId);
  const configured = polls.configPhase === 'ready';
  const busy = configured && ['idle', 'loading', 'submitting'].includes(state.phase);
  host.setAttribute('aria-busy', String(busy));
  host.querySelector('.poll-choices').hidden = !configured || state.phase === 'closed';
  for (const button of host.querySelectorAll('[data-choice]')) {
    button.disabled = !configured || !polls.identity.available || state.phase !== 'ready' || Boolean(state.result?.yourVote);
    button.setAttribute('aria-pressed', String(state.result?.yourVote === button.dataset.choice));
  }
  const results = host.querySelector('.poll-results');
  results.hidden = !configured || !state.result || state.phase === 'closed';
  if (!results.hidden) {
    const result = state.result;
    const percentages = votePercentages(result);
    const stale = state.phase !== 'ready';
    host.querySelector('.poll-total').textContent = `${result.total.toLocaleString('en-US')} vote${result.total === 1 ? '' : 's'} · ${stale ? 'last loaded results' : 'shared results'}`;
    host.querySelector('.poll-approve').textContent = `${result.approve.toLocaleString('en-US')} · ${percentages.approve}%`;
    host.querySelector('.poll-not-convinced').textContent = `${result.notConvinced.toLocaleString('en-US')} · ${percentages.notConvinced}%`;
    host.querySelector('.poll-bar span').style.width = `${percentages.approve}%`;
  }
  let message;
  if (polls.configPhase === 'loading') message = 'Loading visitor voting…';
  else if (polls.configPhase === 'unavailable') message = 'Voting is not available yet. Please check back after polls open.';
  else if (polls.configPhase === 'error') message = 'Visitor voting could not be loaded. Please try again.';
  else if (state.phase === 'closed') message = 'This update is not open for voting. Refresh the scoreboard for the latest check-in.';
  else if (state.phase === 'idle' || state.phase === 'loading') message = state.result ? 'Refreshing shared results…' : 'Loading shared results…';
  else if (state.phase === 'submitting') message = `Saving your ${choiceNames[state.attemptedChoice]} vote…`;
  else if (state.phase === 'read-error') message = state.result ? 'Results could not be refreshed. The last loaded results are shown. Please try again.' : 'Shared results could not be loaded. Please try again.';
  else if (state.phase === 'vote-error') message = state.errorStatus === 429 ? 'Voting is busy. Please retry the same vote in a moment.' : 'We could not confirm your vote. It may have been saved. Check its status or retry the same vote.';
  else if (!polls.identity.available) message = 'You can view shared results, but voting needs browser storage to remember your choice. Enable it and reload to vote.';
  else if (state.result.yourVote) message = `Your vote: ${choiceNames[state.result.yourVote]}. Thanks for weighing in.`;
  else message = state.result.total ? 'How do you feel about this update?' : 'No votes yet. How do you feel about this update?';
  host.querySelector('.poll-status').textContent = message;
  const refresh = host.querySelector('.poll-refresh');
  refresh.hidden = ['loading', 'unavailable'].includes(polls.configPhase);
  refresh.disabled = busy;
  refresh.textContent = polls.configPhase === 'error' ? 'Try loading voting' : state.phase === 'closed' ? 'Refresh scoreboard' : state.phase === 'vote-error' ? 'Check vote status' : state.phase === 'read-error' ? 'Try again' : 'Refresh results';
  const retryVote = host.querySelector('.poll-retry-vote');
  retryVote.hidden = !configured || state.phase !== 'vote-error' || !state.attemptedChoice;
  retryVote.textContent = state.attemptedChoice ? `Retry my ${choiceNames[state.attemptedChoice]} vote` : '';
  host.querySelector('.poll-help').hidden = !configured;
  if (configured) polls.ensure(pollId);
}

function renderVoting() {
  if (!currentData) return;
  const state = getTrackerState(currentData);
  const entry = selectedDay ? currentData.days[selectedDay - 1] : null;
  const todayId = pollIdFor(state.today, state.currentDate);
  renderPoll($('today-poll'), state.today, state.currentDate);
  renderPoll($('day-poll'), pollIdFor(entry, state.currentDate) === todayId ? null : entry, state.currentDate);
}

function refreshVisiblePolls() {
  for (const host of [$('today-poll'), $('day-poll')]) {
    if (!host.hidden && host.dataset.pollId) polls.refresh(host.dataset.pollId);
  }
}

async function loadVotingConfig() {
  if (votingConfigLoading) return;
  votingConfigLoading = true;
  polls.configPhase = 'loading';
  polls.emit();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = new URL('./voting-config.json', import.meta.url);
    url.searchParams.set('_', String(Date.now()));
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Voting configuration unavailable.');
    const config = validateVotingConfig(await response.json(), window.location.href);
    if (config.apiBaseUrl && !polls.identity.available) {
      try { polls.identity = browserIdentity(window.localStorage, window.crypto); } catch { /* Storage can be blocked at the property getter. */ }
    }
    polls.setConfig(config);
  } catch { polls.configFailed(); }
  finally { clearTimeout(timeout); votingConfigLoading = false; }
}
polls.subscribe(renderVoting);

function prettyDate(date, options = { month: 'short', day: 'numeric' }) {
  // Calendar dates are deliberately formatted as UTC: there is no local-midnight shift.
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

function pendingText(entry, state) {
  return entry.date > state.currentDate ? 'Future day · check-in ahead' : 'Awaiting a source report';
}

function showDay(day, focus = false) {
  if (!currentData) return;
  selectedDay = day;
  const state = getTrackerState(currentData);
  const entry = currentData.days[day - 1];
  for (const button of $('day-strip').children) {
    const chosen = Number(button.dataset.day) === day;
    button.setAttribute('aria-pressed', String(chosen));
    button.tabIndex = chosen ? 0 : -1;
    if (chosen && focus) button.focus();
  }
  const detail = $('day-detail');
  detail.replaceChildren();
  const p = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = `Day ${day} · ${prettyDate(entry.date)} · ${entry.status === 'pending' ? 'Pending' : names[entry.status]}`;
  p.append(strong, document.createElement('br'), entry.status === 'pending' ? pendingText(entry, state) : entry.summary || 'Result recorded. See the source post for details.');
  detail.append(p);
  if (entry.tweetUrl) {
    const a = document.createElement('a');
    a.href = entry.tweetUrl;
    a.textContent = 'Read the source post ↗';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', `Read source post for day ${day} on X, opens a new tab`);
    detail.append(a);
  }
  if (entry.status === 'pending') {
    const note = document.createElement('p');
    note.className = 'poll-pending-note';
    note.textContent = 'Voting opens when this day has a published check-in. Select a recorded day above to see its poll.';
    detail.append(note);
  }
  renderVoting();
}

function renderData() {
  const focusedDay = document.activeElement?.classList.contains('day-button');
  const state = getTrackerState(currentData);
  const age = freshness(currentData);
  clockKey = `${state.currentDate}:${age.status}`;
  $('phase-badge').replaceChildren();
  $('phase-badge').append(document.createElement('span'), state.phase === 'active' ? 'In progress' : state.phase === 'before' ? 'Starting soon' : 'Window complete');
  $('day-label').textContent = state.phase === 'before' ? 'Getting ready' : state.phase === 'after' ? 'Final day' : 'Day';
  $('day-number').textContent = String(state.day).padStart(2, '0');
  document.querySelector('.day-counter').setAttribute('aria-label', `Day ${state.day} of 28${state.phase === 'before' ? ', before the tracking window' : state.phase === 'after' ? ', tracking window complete' : ''}`);
  $('current-date').textContent = prettyDate(state.currentDate, { weekday: 'short', month: 'short', day: 'numeric' });
  $('count-improvement').textContent = state.counts.improvement;
  $('count-reset').textContent = state.counts.reset;
  $('count-pending').textContent = state.counts.pending;
  $('pending-breakdown').textContent = `${state.awaitingReports} awaiting · ${state.futurePending} ahead`;
  const result = state.today;
  const status = result?.status || 'pending';
  $('today-card').dataset.status = status;
  $('today-icon').textContent = icons[status];
  $('today-label').textContent = state.phase === 'before' ? 'BEFORE THE FIRST CHECK-IN' : state.phase === 'after' ? 'AFTER THE FINAL CHECK-IN' : 'TODAY’S CHECK-IN';
  $('today-status').textContent = state.phase === 'before' ? 'The countdown is on' : state.phase === 'after' ? 'That’s the 28-day window' : names[status];
  $('today-summary').textContent = state.phase === 'before' ? `Day 1 starts ${prettyDate(currentData.startDate)} in Pacific time. All future days remain pending.` : state.phase === 'after' ? `${state.counts.pending} day${state.counts.pending === 1 ? '' : 's'} still pending. Reports can be added after the window closes.` : status === 'pending' ? 'No verified result recorded yet. The cheering section is on standby.' : result.summary || 'Result recorded. See the source post for details.';
  $('today-source').hidden = !result?.tweetUrl;
  if (result?.tweetUrl) $('today-source').href = result.tweetUrl;
  const recorded = 28 - state.counts.pending;
  $('journey-progress').textContent = `${recorded} / 28 recorded${state.counts.missed ? ` · ${state.counts.missed} missed` : ''}`;
  $('day-strip').replaceChildren();
  for (const entry of currentData.days) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-button';
    button.dataset.day = entry.day;
    button.dataset.status = entry.status;
    button.dataset.future = String(entry.date > state.currentDate);
    button.dataset.today = String(entry.date === state.currentDate);
    button.textContent = entry.day;
    const label = `Day ${entry.day}, ${prettyDate(entry.date)}, ${entry.status === 'pending' ? `pending, ${pendingText(entry, state)}` : names[entry.status]}${entry.date === state.currentDate ? ', today' : ''}`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', () => showDay(entry.day));
    button.addEventListener('keydown', (event) => {
      const offsets = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 14, ArrowUp: -14 };
      const columns = getComputedStyle($('day-strip')).gridTemplateColumns.split(' ').length;
      if (event.key === 'ArrowDown') offsets.ArrowDown = columns;
      if (event.key === 'ArrowUp') offsets.ArrowUp = -columns;
      if (event.key in offsets || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const next = event.key === 'Home' ? 1 : event.key === 'End' ? 28 : Math.max(1, Math.min(28, entry.day + offsets[event.key]));
        showDay(next, true);
      }
    });
    $('day-strip').append(button);
  }
  showDay(selectedDay || (state.phase === 'before' ? 1 : state.day), focusedDay);
  const updated = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: currentData.timezone, timeZoneName: 'short' });
  $('data-status').textContent = age.status === 'never' ? 'Never updated · results unverified' : age.status === 'stale' ? 'Data may be stale' : age.status === 'future' ? 'Update timestamp is ahead of the clock' : 'Data updated from @thsottiaux posts';
  $('data-explanation').textContent = age.status === 'never' ? 'Data updated from @thsottiaux posts. No source reports have been entered yet; all 28 days are pending.' : `Last manual update: ${updated.format(new Date(currentData.updatedAt))}.${age.status === 'stale' ? ' More than 24 hours old. Pending is not a missed day.' : age.status === 'future' ? ' Treat these results cautiously until the timestamp is corrected.' : ' Pending days include future check-ins and unreported results.'}`;
  setShare(state);
}

function cleanPageUrl() {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  return url.href;
}

function setShare(state = null) {
  const text = state ? `Codex 28 · Day ${state.day} of 28. ${state.counts.improvement} improvements, ${state.counts.reset} resets, ${state.counts.pending} pending. Tiny ships. Big energy. Unofficial fan tracker.` : 'Codex 28 · Tiny ships. Big energy. An unofficial 28-day fan scoreboard.';
  const intent = new URL('https://twitter.com/intent/tweet');
  intent.searchParams.set('text', text);
  intent.searchParams.set('url', cleanPageUrl());
  $('share').href = intent.href;
}

async function loadData() {
  if (loading) return;
  if (polls.configPhase === 'error') loadVotingConfig();
  loading = true;
  $('retry').disabled = true;
  $('retry').setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = new URL('./data.json', import.meta.url);
    url.searchParams.set('_', String(Date.now()));
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Data could not be fetched');
    currentData = validateData(await response.json());
    renderData();
    refreshVisiblePolls();
  } catch {
    $('data-status').textContent = currentData ? 'Refresh failed · showing the previous load' : 'Scoreboard data unavailable';
    $('data-explanation').textContent = 'The public data could not be loaded or validated. Please try refresh. No results have been assumed.';
    if (!currentData) {
      $('phase-badge').textContent = 'Data unavailable';
      $('today-status').textContent = 'Check-in unavailable';
      $('today-summary').textContent = 'We couldn’t load valid data. Try the refresh button below.';
      $('current-date').textContent = 'Calendar unavailable';
      $('journey-progress').textContent = 'Results unavailable';
      $('day-detail').textContent = 'Day details will appear once valid data is available.';
    }
  } finally {
    clearTimeout(timeout);
    loading = false;
    $('retry').disabled = false;
    $('retry').removeAttribute('aria-busy');
  }
}

$('retry').addEventListener('click', loadData);
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cleanPageUrl());
    $('copy').lastChild.textContent = 'Copied!';
    $('copy-feedback').textContent = 'Link copied to clipboard.';
    setTimeout(() => { $('copy').lastChild.textContent = 'Copy link'; }, 2400);
  } catch {
    $('copy-fallback').hidden = false;
    $('copy-url').value = cleanPageUrl();
    $('copy-url').focus();
    $('copy-url').select();
    $('copy-feedback').textContent = 'Clipboard unavailable. The link is selected below; copy it manually.';
  }
});
let cheerCount = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const cheers = ['one small ship for dotkind', 'reset? we brought a fresh tank', 'the dots believe in useful little things', 'a very small cheering section'];
for (const dot of document.querySelectorAll('.dot-character')) {
  let x = 0, y = 0, drag = null, suppressClick = false;
  const bounds = () => ({ left: -dot.offsetLeft, top: -dot.offsetTop, right: $('dot-stage').clientWidth - dot.offsetLeft - dot.offsetWidth, bottom: $('dot-stage').clientHeight - dot.offsetTop - dot.offsetHeight });
  const move = (nextX, nextY) => {
    const b = bounds();
    x = Math.max(b.left, Math.min(b.right, nextX));
    y = Math.max(b.top, Math.min(b.bottom, nextY));
    dot.style.setProperty('--dot-x', `${x}px`);
    dot.style.setProperty('--dot-y', `${y}px`);
  };
  const react = () => {
    $('crew-caption').textContent = cheers[cheerCount++ % cheers.length];
    if (!reducedMotion.matches) dot.animate([{ scale: '1', rotate: '0deg' }, { scale: '1.08', rotate: '-6deg' }, { scale: '1', rotate: '0deg' }], { duration: 400, easing: 'ease-out' });
  };
  dot.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x, y, moved: false };
    suppressClick = false;
    dot.setPointerCapture(event.pointerId);
    dot.classList.add('dragging');
  });
  dot.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) move(drag.x + dx, drag.y + dy);
  });
  const release = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const completedDrag = drag;
    drag = null;
    suppressClick = completedDrag.moved;
    if (dot.hasPointerCapture(event.pointerId)) dot.releasePointerCapture(event.pointerId);
    dot.classList.remove('dragging');
    if (completedDrag.moved && event.type !== 'pointercancel') react();
  };
  dot.addEventListener('pointerup', release);
  dot.addEventListener('pointercancel', release);
  dot.addEventListener('lostpointercapture', () => { dot.classList.remove('dragging'); drag = null; });
  dot.addEventListener('click', () => { if (!suppressClick) react(); suppressClick = false; });
  dot.addEventListener('keydown', (event) => {
    const directions = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] };
    if (event.key in directions) {
      event.preventDefault();
      const [dx, dy] = directions[event.key];
      move(x + dx, y + dy);
    } else if (event.key === 'Home') { event.preventDefault(); move(0, 0); }
  });
  window.addEventListener('resize', () => move(x, y));
}
// Keep the Pacific day counter correct in tabs left open across midnight.
function checkClock() {
  if (!currentData) return;
  const key = `${getTrackerState(currentData).currentDate}:${freshness(currentData).status}`;
  if (key !== clockKey) { clockKey = key; renderData(); }
}
setInterval(checkClock, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkClock(); refreshVisiblePolls(); } });
setShare();
loadVotingConfig();
loadData();
