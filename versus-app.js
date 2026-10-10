import { validateVersusData, getVersusState, getHealth, healthTone, shouldFlashHealth, getMidnightCountdown } from './versus-model.js';
import { freshness } from './model.js';
import { validateVersusConfig, VersusPollStore } from './versus-poll.js';
import { UpdatePolls } from './versus-update-polls.js';

const $ = id => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let data = null, allRounds = false, loading = false, lastDate = '', muted = true, audio = null;
let lastVotes = null;
// Getter access itself can throw in privacy modes; the store fails closed without storage.
let storage = null;
try { storage = window.localStorage; } catch { /* Read-only poll mode. */ }
const poll = new VersusPollStore({ storage, locks: navigator.locks });
const updatePolls = new UpdatePolls({ onReloadData: () => loadData() });
const count = value => value === null ? '?' : String(value);
const text = (id, value) => { $(id).textContent = value; };
const prettyDate = date => new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const teamName = side => data?.teams[side].team.toUpperCase() || `TEAM ${side.toUpperCase()}`;
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function sourceLink(url, label) {
  const a = element('a', '', label);
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', `${label.replace(' ↗', '')}, opens X in a new tab`);
  return a;
}
function renderTeam(side, totals) {
  const team = data.teams[side];
  for (const id of [`team-${side}`, `health-team-${side}`, `vote-label-${side}`, `log-${side}`]) text(id, teamName(side));
  text(`name-${side}`, team.name);
  text(`health-name-${side}`, team.name);
  text(`handle-${side}`, `@${team.handle}`);
  text(`product-${side}`, team.product);
  text(`role-${side}`, team.role);
  $(`portrait-${side}`).src = new URL(team.avatar, import.meta.url).href;
  $(`portrait-${side}`).alt = team.name;
  $(`source-${side}`).href = team.profileUrl;
  $(`source-${side}`).textContent = `@${team.handle.toUpperCase()} ↗`;
  $(`health-${side}`).setAttribute('aria-label', `${team.name} daily community support health`);
  text(`hits-${side}`, count(totals.hits));
  text(`resets-${side}`, count(totals.resets));
  text(`note-${side}`, totals.unclassified ? `${totals.unclassified} unclassified records · ${totals.confirmedHits} confirmed hits / ${totals.confirmedResets} resets` : `${totals.pending} pending days · explicit status records only`);
}
function laneNode(side, lane, round, currentDate) {
  const host = element('div', `round-lane ${side}`);
  host.append(element('p', 'lane-summary', `${teamName(side)} · ${count(lane.hits)} HITS / ${count(lane.resets)} RESETS${lane.unclassified ? ` · ${lane.unclassified} UNCLASSIFIED` : ''}`));
  if (!lane.entries.length) {
    const empty = element('div', 'no-move');
    empty.append(element('b', '', 'NO MOVE'), element('span', '', lane.pending ? 'Pending · no source report entered' : 'No recorded update'));
    host.append(empty);
  }
  for (const entry of lane.entries) {
    const move = element('article', 'move');
    const header = element('div', 'move-header');
    header.append(element('b', '', side === 'dots' ? `DAY ${entry.number} RECORD` : `UPDATE ${entry.number}`), element('span', '', entry.classification === 'unknown' ? 'UNCLASSIFIED' : entry.status.toUpperCase()));
    move.append(header, element('p', '', entry.summary));
    if (entry.sourceUrl) move.append(sourceLink(entry.sourceUrl, 'SOURCE ↗'));
    if (entry.potetoUrl && entry.potetoUrl !== entry.sourceUrl) move.append(sourceLink(entry.potetoUrl, '@POTETO ↗'));
    if (side === 'dots') {
      const updatePoll = updatePolls.nodeFor(data.tracker.days[round.day - 1], currentDate);
      if (updatePoll) move.append(updatePoll);
    }
    host.append(move);
  }
  return host;
}
function renderTimeline(state) {
  $('timeline').replaceChildren();
  const rounds = state.rounds.filter(r => allRounds || r.date <= state.currentDate || r.day === 1).slice().reverse();
  for (const round of rounds) {
    const row = element('section', 'round-row');
    row.setAttribute('aria-label', `Round ${round.day}, ${prettyDate(round.date)}`);
    const result = element('div', 'round-result');
    const label = round.winner === 'unresolved' ? 'UNRESOLVED' : round.winner === 'draw' ? 'DRAW' : `${teamName(round.winner)} WINS`;
    result.append(element('p', 'round-tag', `ROUND ${String(round.day).padStart(2, '0')}`), element('p', 'round-date', prettyDate(round.date).toUpperCase()), element('strong', '', label));
    if (round.winner === 'unresolved') result.append(element('small', '', 'Classification incomplete'));
    else if (round.date > state.currentDate) result.append(element('small', '', 'Future round'));
    else if (round.date === state.currentDate) result.append(element('small', '', 'Round in progress'));
    row.append(laneNode('dots', round.dots, round, state.currentDate), result, laneNode('bots', round.bots, round, state.currentDate));
    $('timeline').append(row);
  }
  text('show-all', allRounds ? 'RECORDED ROUNDS ↑' : 'ALL 28 ROUNDS ↓');
  $('show-all').setAttribute('aria-pressed', String(allRounds));
  updatePolls.renderVisible();
}
function renderData() {
  const state = getVersusState(data);
  lastDate = state.currentDate;
  text('round-number', String(state.round).padStart(2, '0'));
  text('round-date', `${prettyDate(state.currentDate).toUpperCase()} · PT${state.phase === 'after' ? ' · WINDOW CLOSED' : state.phase === 'before' ? ' · STARTING SOON' : ''}`);
  text('window-label', `THE RECEIPTS / ${prettyDate(data.tracker.startDate).toUpperCase()} — ${prettyDate(data.tracker.endDate).toUpperCase()}, ${data.tracker.startDate.slice(0, 4)}`);
  for (const side of ['dots', 'bots']) renderTeam(side, state.totals[side]);
  renderTimeline(state);
  const final = state.finale;
  $('finale').hidden = final.status === 'ongoing';
  if (final.status === 'ko') text('finale', `KO! ${teamName(final.winner)} WINS · VERIFIED HIT TOTAL`);
  else if (final.status === 'draw') text('finale', 'FINAL DRAW · EQUAL RECORDED HITS');
  else if (final.status === 'unresolved') text('finale', 'WINDOW CLOSED · RESULT UNRESOLVED · RECORDS INCOMPLETE');
  const ages = [freshness(data.tracker).status, freshness({updatedAt:data.updatedAt}).status];
  text('data-status', `SOURCE RECORDS · Tibo ${data.tracker.updatedAt} · Grok ${data.updatedAt}. ${ages.includes('future') ? 'Timestamp ahead of the clock.' : ages.includes('stale') ? 'Data may be stale.' : 'Loaded.'} ${state.totals.bots.unclassified ? 'Grok classifications missing; winner unresolved.' : ''}`);
  const page = new URL(location.href); page.search = ''; page.hash = '';
  const share = new URL('https://twitter.com/intent/tweet');
  share.searchParams.set('url', page.href);
  share.searchParams.set('text', `CODEX 28 · Round ${state.round}/28. ${teamName('dots')}: ${count(state.totals.dots.hits)} hits, ${count(state.totals.dots.resets)} resets. ${teamName('bots')}: ${state.totals.bots.unclassified ? `${state.totals.bots.unclassified} unclassified records` : `${count(state.totals.bots.hits)} hits, ${count(state.totals.bots.resets)} resets`}. Fan-made tracker.`);
  $('share-link').href = share.href;
  tick();
}
async function fetchJson(file, signal) {
  const url = new URL(file, import.meta.url); url.searchParams.set('_', Date.now());
  const response = await fetch(url, {cache:'no-store', signal});
  if (!response.ok) throw new Error('Public file unavailable');
  return response.json();
}
async function loadData() {
  if (loading) return;
  loading = true; $('data-refresh').disabled = true;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const [tibo, versus] = await Promise.all([fetchJson('./data.json', controller.signal), fetchJson('./versus.json', controller.signal)]);
    data = validateVersusData(tibo, versus);
    renderData();
    updatePolls.refreshVisible();
  } catch {
    text('data-status', data ? 'Refresh failed · previous source records remain visible. Try again.' : 'Data unavailable · no results assumed. Refresh to retry.');
    if (!data) { text('round-number', '--'); text('timeline', 'Source records unavailable. No results assumed.'); }
  } finally { clearTimeout(timeout); loading = false; $('data-refresh').disabled = false; }
}
function hitSound() {
  if (muted || !audio || audio.state !== 'running') return;
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  oscillator.type = 'square'; oscillator.frequency.setValueAtTime(150, audio.currentTime); oscillator.frequency.exponentialRampToValueAtTime(40, audio.currentTime + .13);
  gain.gain.setValueAtTime(.025, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .15);
  oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .16);
}
function renderHealth(result) {
  const health = result ? getHealth(result.dotsVotes, result.botsVotes) : null;
  const sameDay = result && lastVotes?.day === result.day;
  const newVotes = sameDay && result.totalVotes > lastVotes.totalVotes;
  for (const side of ['dots','bots']) {
    const value = health ? (side === 'dots' ? health.tiboHealth : health.potetoHealth) : 100;
    const track = $(`health-${side}`);
    track.style.setProperty('--hp', value / 100);
    track.dataset.tone = healthTone(value);
    track.dataset.critical = String(shouldFlashHealth(value));
    track.setAttribute('aria-valuenow', value.toFixed(2));
    track.setAttribute('aria-valuetext', health ? `${value.toFixed(1)} percent support health` : 'Poll not configured; neutral display');
    text(`hp-${side}`, health ? `HP ${value.toFixed(1)}` : 'HP —');
    const opponentAdded = newVotes && (side === 'dots' ? result.botsVotes > lastVotes.botsVotes : result.dotsVotes > lastVotes.dotsVotes);
    if (!reduced.matches && opponentAdded) {
      const fighter = $(`fighter-${side}`); fighter.classList.remove('hit'); void fighter.offsetWidth; fighter.classList.add('hit');
      setTimeout(() => fighter.classList.remove('hit'), 350);
    }
  }
  if (newVotes) hitSound();
  if (result) lastVotes = {...result};
}
function renderPoll() {
  const result = poll.result, phase = poll.phase;
  const configured = phase !== 'coming-soon';
  const busy = ['idle','loading','submitting'].includes(phase);
  $('poll').setAttribute('aria-busy', String(busy));
  for (const side of ['dots','bots']) {
    $(`vote-${side}`).disabled = phase !== 'ready' || !result || result.open === false || Boolean(result.yourVote);
    $(`vote-${side}`).setAttribute('aria-pressed', String(result?.yourVote === side));
  }
  $('poll-refresh').hidden = !configured;
  $('poll-refresh').disabled = busy;
  text('poll-refresh', ['vote-error','read-error','storage-error'].includes(phase) ? 'CHECK STATUS / RETRY ↻' : 'REFRESH RESULTS ↻');
  let message = 'COMING SOON · The team poll is not configured.';
  if (phase === 'loading' || phase === 'idle') message = 'CONNECTING · Loading shared counts…';
  else if (phase === 'submitting') message = 'SAVING · Waiting for the server to confirm your vote…';
  else if (phase === 'closed') message = 'MATCH CLOSED · Team voting is open only during the 28-day window.';
  else if (phase === 'storage-error') message = 'DEVICE STORAGE REQUIRED · Enable persistent storage and reload to vote.';
  else if (phase === 'read-error' && poll.errorStatus === 429) message = 'RATE LIMITED · The voting service is busy. Wait before retrying.';
  else if (phase === 'read-error') message = result ? 'REFRESH FAILED · Last loaded counts shown. Check status to retry.' : 'RESULTS UNAVAILABLE · Check status to retry.';
  else if (phase === 'vote-error') message = poll.errorStatus === 429 ? 'RATE LIMITED · Wait a moment, then retry the same side.' : 'VOTE UNCONFIRMED · It may have saved. Check status before retrying the same side.';
  else if (phase === 'ready') message = result?.yourVote ? `LOCKED IN · ${teamName(result.yourVote)} · Your device has voted for ${result.day} PT.` : 'MATCH OPEN · Choose a side. One saved device identity per Pacific day.';
  text('poll-status', message);
  if (result) {
    const health = getHealth(result.dotsVotes, result.botsVotes);
    text('votes-dots', `${result.dotsVotes.toLocaleString()} VOTES / ${health.dotsPercent.toFixed(1)}%`);
    text('votes-bots', `${result.botsVotes.toLocaleString()} VOTES / ${health.botsPercent.toFixed(1)}%`);
    text('votes-total', `${result.totalVotes.toLocaleString()} TOTAL · ${result.day} PT`);
    $('support-dots').style.width = `${result.totalVotes ? health.dotsPercent : 50}%`;
  } else {
    text('votes-dots', '— VOTES / —%'); text('votes-bots','— VOTES / —%'); text('votes-total', configured ? 'AWAITING SERVER' : 'COMING SOON');
  }
  renderHealth(result);
}
async function loadPollConfig() {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const raw = await fetchJson('./versus-config.json', controller.signal);
    poll.setConfig(validateVersusConfig(raw, location.href));
    if (poll.phase !== 'coming-soon') await poll.load();
  } catch { text('poll-status', 'COMING SOON · Poll configuration unavailable. Refresh data or reload to retry.'); }
  finally { clearTimeout(timeout); }
}
function tick() {
  if (!data) return;
  const clock = getMidnightCountdown(new Date(), data.tracker.timezone);
  text('countdown', clock.label);
  if (clock.currentDate !== lastDate) { renderData(); poll.refresh(); }
}
$('data-refresh').addEventListener('click', () => { loadData(); if (poll.phase === 'coming-soon') loadPollConfig(); if (updatePolls.store.configPhase === 'error') updatePolls.loadConfig(); });
$('show-all').addEventListener('click', () => { allRounds = !allRounds; if (data) renderTimeline(getVersusState(data)); });
$('vote-dots').addEventListener('click', () => poll.vote('dots'));
$('vote-bots').addEventListener('click', () => poll.vote('bots'));
$('poll-refresh').addEventListener('click', async () => { await poll.refresh(); if (['ready','vote-error'].includes(poll.phase) && poll.errorStatus === null && !poll.result?.yourVote && poll.pendingTeam) await poll.vote(poll.pendingTeam); });
$('sound-toggle').addEventListener('click', async () => {
  if (muted) {
    try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); await audio.resume(); muted = false; }
    catch { text('sound-toggle','♪ SOUND UNAVAILABLE'); return; }
  } else muted = true;
  $('sound-toggle').setAttribute('aria-pressed', String(!muted));
  text('sound-toggle', muted ? '♪ SOUND OFF' : '♪ SOUND ON');
});
$('copy-link').addEventListener('click', async () => {
  const url = new URL(location.href); url.search = ''; url.hash = '';
  try { await navigator.clipboard.writeText(url.href); text('copy-status','LINK COPIED'); }
  catch { $('copy-fallback').hidden = false; $('copy-fallback').value = url.href; $('copy-fallback').focus(); $('copy-fallback').select(); text('copy-status','Copy the selected link manually.'); }
});
poll.subscribe(renderPoll);
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden && poll.phase !== 'coming-soon') poll.refresh(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); if (poll.phase !== 'coming-soon') poll.refresh(); updatePolls.refreshVisible(); } });
renderPoll(); loadData(); loadPollConfig(); updatePolls.loadConfig();
