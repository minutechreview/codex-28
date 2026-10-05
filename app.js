import { validateData, getTrackerState, freshness } from './model.js';

const $ = (id) => document.getElementById(id);
const names = { improvement: 'Improvement', reset: 'Reset', pending: 'Waiting', missed: 'Missed' };
const icons = { improvement: '↑', reset: '↻', pending: '…', missed: '×' };
let currentData = null;
let selectedDay = null;
let loading = false;
let clockKey = '';

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
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkClock(); });
setShare();
loadData();
