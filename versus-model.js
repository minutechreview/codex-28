/** Pure VERSUS logic. Public summaries belong in textContent, never innerHTML. */
import { DataValidationError, TOTAL_DAYS, dateInTimezone, getTrackerState, validateData } from "./model.js";

export const TOTAL_ROUNDS = TOTAL_DAYS;
export const PACIFIC_TIMEZONE = "America/Los_Angeles";
const DAY_MS = 86_400_000;
const CLASSIFICATIONS = Object.freeze(["improvement", "reset", "pending", "missed"]);
const TEAM_KEYS = ["team", "name", "handle", "profileUrl", "role", "avatar", "product", "entriesSource"];
const ENTRY_KEYS = ["number", "summary", "tweetUrl", "postedAt", "announcedBy", "potetoUrl"];
const midnightCache = new Map();

function fail(message) {
  throw new DataValidationError(message);
}

function assertRecord(value, required, label, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain JSON object.`);
  const keys = Reflect.ownKeys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => ![...required, ...optional].includes(key))) {
    fail(`${label} has missing or unexpected fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail(`${label} must contain plain JSON values.`);
  }
}

function assertText(value, label, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    fail(`${label} must be nonempty plain text of at most ${max} characters.`);
  }
}

/** Only public HTTPS X profiles/posts are accepted as source links. */
export function isSafeSourceUrl(value, postOnly = false) {
  if (typeof value !== "string" || value.length > 250 || /\s/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const pattern = postOnly ? /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/ : /^\/[A-Za-z0-9_]{1,15}(?:\/status\/\d+)?\/?$/;
  return url.protocol === "https:" && ["x.com", "www.x.com"].includes(url.hostname)
    && !url.username && !url.password && !url.port && !url.search && !url.hash && pattern.test(url.pathname);
}

function assertSourceUrl(value, label, postOnly = false) {
  if (!isSafeSourceUrl(value, postOnly)) fail(`${label} must be a plain HTTPS X ${postOnly ? "post" : "profile or post"} URL.`);
}

function assertTimestamp(value, label) {
  if (typeof value !== "string") fail(`${label} must be an ISO timestamp with a timezone.`);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail(`${label} must be an ISO timestamp with a timezone.`);
  const day = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]
      || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) fail(`${label} is not a real timestamp.`);
  if (match[5] !== "Z") {
    const hour = Number(match[5].slice(1, 3));
    const minute = Number(match[5].slice(4, 6));
    if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) fail(`${label} has an invalid timezone offset.`);
  }
  if (!Number.isFinite(Date.parse(value))) fail(`${label} is not a real timestamp.`);
}

function validateTeam(raw, side) {
  const label = `${side} team`;
  assertRecord(raw, TEAM_KEYS, label);
  for (const key of ["team", "name", "role", "product"]) assertText(raw[key], `${label} ${key}`, 150);
  if (typeof raw.handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(raw.handle)) fail(`${label} handle is invalid.`);
  assertSourceUrl(raw.profileUrl, `${label} profileUrl`);
  if (typeof raw.avatar !== "string" || !/^assets\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|gif|svg)$/.test(raw.avatar)) {
    fail(`${label} avatar must be a local assets image.`);
  }
  const expectedSource = side === "dots" ? "data.json" : "versus.json#days[].grokbot";
  if (raw.entriesSource !== expectedSource) fail(`${label} entriesSource does not match the existing source schema.`);
  return Object.freeze(Object.fromEntries(TEAM_KEYS.map((key) => [key, raw[key]])));
}

function validateGrokEntry(raw, day, index, timezone) {
  const label = `Round ${day.day} Grok entry ${index + 1}`;
  assertRecord(raw, ENTRY_KEYS, label, ["status", "type"]);
  if (typeof raw.number !== "string" || !new RegExp(`^${day.day}\\.[1-9]\\d*$`).test(raw.number)) {
    fail(`${label} number must identify its round and update.`);
  }
  assertText(raw.summary, `${label} summary`, 1000);
  assertSourceUrl(raw.tweetUrl, `${label} tweetUrl`, true);
  if (raw.potetoUrl !== null) assertSourceUrl(raw.potetoUrl, `${label} potetoUrl`, true);
  assertTimestamp(raw.postedAt, `${label} postedAt`);
  if (dateInTimezone(raw.postedAt, timezone) !== day.date) fail(`${label} postedAt does not match its round's local date.`);
  if (typeof raw.announcedBy !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(raw.announcedBy)) fail(`${label} announcedBy is invalid.`);
  const explicit = [raw.status, raw.type].filter((value) => value !== undefined);
  if (explicit.some((value) => !CLASSIFICATIONS.includes(value))) fail(`${label} has an unknown explicit classification.`);
  if (explicit.length === 2 && explicit[0] !== explicit[1]) fail(`${label} has conflicting classifications.`);
  const classification = explicit[0] ?? "unknown";
  return Object.freeze({
    number: raw.number,
    summary: raw.summary,
    tweetUrl: raw.tweetUrl,
    sourceUrl: raw.tweetUrl,
    postedAt: raw.postedAt,
    announcedBy: raw.announcedBy,
    potetoUrl: raw.potetoUrl,
    status: explicit[0] ?? null,
    classification,
  });
}

function makeLane(entries, status, pending = 0) {
  const frozenEntries = Object.freeze(entries);
  const confirmedHits = entries.filter((entry) => entry.classification === "improvement").length;
  const confirmedResets = entries.filter((entry) => entry.classification === "reset").length;
  const unclassified = entries.filter((entry) => entry.classification === "unknown").length;
  const pendingCount = pending + entries.filter((entry) => entry.classification === "pending").length;
  return Object.freeze({
    entries: frozenEntries,
    status,
    hits: unclassified ? null : confirmedHits,
    resets: unclassified ? null : confirmedResets,
    confirmedHits,
    confirmedResets,
    unclassified,
    pending: pendingCount,
    reported: entries.filter((entry) => entry.classification !== "pending").length,
    classificationKnown: unclassified === 0,
    noMove: entries.length === 0,
  });
}

/** Compare confirmed improvement records only. Resets never count as hits. */
export function getRoundWinner(dots, bots) {
  if (dots.noMove && bots.noMove) return "draw";
  if (!dots.classificationKnown || !bots.classificationKnown || dots.pending || bots.pending) return "unresolved";
  if (dots.confirmedHits === bots.confirmedHits) return "draw";
  return dots.confirmedHits > bots.confirmedHits ? "dots" : "bots";
}

/** Read the repository's two data files without changing or inferring source content. */
export function validateVersusData(rawTracker, rawVersus) {
  const tracker = validateData(rawTracker);
  assertRecord(rawVersus, ["startDate", "endDate", "timezone", "teams", "days", "updatedAt"], "VERSUS data");
  for (const key of ["startDate", "endDate", "timezone"]) {
    if (rawVersus[key] !== tracker[key]) fail(`VERSUS ${key} must match data.json.`);
  }
  assertTimestamp(rawVersus.updatedAt, "VERSUS updatedAt");
  assertRecord(rawVersus.teams, ["dots", "bots"], "VERSUS teams");
  const teams = Object.freeze({ dots: validateTeam(rawVersus.teams.dots, "dots"), bots: validateTeam(rawVersus.teams.bots, "bots") });
  if (!Array.isArray(rawVersus.days) || rawVersus.days.length !== TOTAL_ROUNDS) fail("VERSUS days must contain exactly 28 rounds.");
  const days = rawVersus.days.map((rawDay, index) => {
    const tibo = tracker.days[index];
    assertRecord(rawDay, ["day", "date", "grokbot"], `VERSUS round ${index + 1}`);
    if (rawDay.day !== tibo.day || rawDay.date !== tibo.date) fail(`VERSUS round ${index + 1} must match data.json's day and date.`);
    if (!Array.isArray(rawDay.grokbot) || rawDay.grokbot.length > 100) fail(`VERSUS round ${index + 1} grokbot must be a list of at most 100 records.`);
    const grokEntries = rawDay.grokbot.map((entry, entryIndex) => validateGrokEntry(entry, rawDay, entryIndex, tracker.timezone));
    if (new Set(grokEntries.map((entry) => entry.number)).size !== grokEntries.length) fail(`VERSUS round ${index + 1} has duplicate update numbers.`);
    const tiboEntries = tibo.status === "pending" ? [] : [Object.freeze({
      // One typed day record is one classified entry; numbers in prose are not a schema.
      number: String(tibo.day),
      summary: tibo.summary,
      tweetUrl: tibo.tweetUrl,
      sourceUrl: tibo.tweetUrl ?? tracker.source,
      postedAt: null,
      announcedBy: teams.dots.handle,
      potetoUrl: null,
      status: tibo.status,
      classification: tibo.status,
    })];
    const dots = makeLane(tiboEntries, tibo.status, tibo.status === "pending" ? 1 : 0);
    const botsStatus = !grokEntries.length ? "empty" : grokEntries.some((entry) => entry.classification === "unknown") ? "unclassified" : "reported";
    const bots = makeLane(grokEntries, botsStatus);
    return Object.freeze({ day: tibo.day, round: tibo.day, date: tibo.date, dots, bots, winner: getRoundWinner(dots, bots) });
  });
  return Object.freeze({ tracker, teams, days: Object.freeze(days), updatedAt: rawVersus.updatedAt });
}

function totalLane(days, side) {
  const totals = { confirmedHits: 0, confirmedResets: 0, unclassified: 0, pending: 0, reported: 0 };
  for (const day of days) {
    for (const key of Object.keys(totals)) totals[key] += day[side][key];
  }
  return Object.freeze({
    ...totals,
    hits: totals.unclassified ? null : totals.confirmedHits,
    resets: totals.unclassified ? null : totals.confirmedResets,
    classificationKnown: totals.unclassified === 0,
  });
}

function completionState(phase, totals) {
  if (phase !== "after") return Object.freeze({ status: "ongoing", winner: null, reason: "The 28-round PT window is still open." });
  if (totals.dots.unclassified || totals.bots.unclassified) {
    return Object.freeze({ status: "unresolved", winner: null, reason: "Some source entries do not classify improvements and resets." });
  }
  if (totals.dots.pending || totals.bots.pending) {
    return Object.freeze({ status: "unresolved", winner: null, reason: "Some round results are still pending." });
  }
  if (totals.dots.confirmedHits === totals.bots.confirmedHits) {
    return Object.freeze({ status: "draw", winner: null, reason: "Both teams have the same number of confirmed improvement entries." });
  }
  return Object.freeze({ status: "ko", winner: totals.dots.confirmedHits > totals.bots.confirmedHits ? "dots" : "bots", reason: "Winner by confirmed improvement entries across all 28 rounds; resets are separate." });
}

export function getVersusState(data, now = new Date()) {
  const state = getTrackerState(data.tracker, now);
  const totals = Object.freeze({ dots: totalLane(data.days, "dots"), bots: totalLane(data.days, "bots") });
  return Object.freeze({
    phase: state.phase,
    round: state.day,
    day: state.day,
    currentDate: state.currentDate,
    today: state.phase === "active" ? data.days[state.day - 1] : null,
    rounds: data.days,
    totals,
    finale: completionState(state.phase, totals),
    countdown: getMidnightCountdown(now, data.tracker.timezone),
  });
}

function asTimestamp(now) {
  const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError("now must be a valid date or timestamp.");
  return timestamp;
}

/** Find the next local calendar-day boundary, including 23/25-hour DST days. */
export function nextMidnight(now = new Date(), timezone = PACIFIC_TIMEZONE) {
  const timestamp = asTimestamp(now);
  const currentDate = dateInTimezone(timestamp, timezone);
  const key = `${timezone}:${currentDate}`;
  if (midnightCache.has(key)) return new Date(midnightCache.get(key));
  let low = timestamp;
  let high = timestamp + DAY_MS * 1.5;
  // Search by local calendar date, rather than adding 24h or assuming PST/PDT.
  while (dateInTimezone(high, timezone) <= currentDate) high += DAY_MS;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dateInTimezone(middle, timezone) === currentDate) low = middle;
    else high = middle;
  }
  midnightCache.set(key, high);
  if (midnightCache.size > 64) midnightCache.delete(midnightCache.keys().next().value);
  return new Date(high);
}

export function getMidnightCountdown(now = new Date(), timezone = PACIFIC_TIMEZONE) {
  const timestamp = asTimestamp(now);
  const end = nextMidnight(timestamp, timezone);
  const milliseconds = end.getTime() - timestamp;
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const label = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  return Object.freeze({ currentDate: dateInTimezone(timestamp, timezone), nextMidnightAt: end.toISOString(), milliseconds, totalSeconds, hours, minutes, seconds, label });
}

/** Poll damage is based on the opposing team's votes; empty polls start at 100%. */
export function getHealth(dotsVotes, botsVotes) {
  if (![dotsVotes, botsVotes].every((value) => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(dotsVotes + botsVotes)) {
    throw new TypeError("Vote counts must be nonnegative safe integers.");
  }
  const totalVotes = dotsVotes + botsVotes;
  const denominator = Math.max(totalVotes, 1);
  return Object.freeze({
    dotsVotes,
    botsVotes,
    totalVotes,
    dotsPercent: 100 * dotsVotes / denominator,
    botsPercent: 100 * botsVotes / denominator,
    tiboHealth: 100 - (100 * botsVotes / denominator) * 0.9,
    potetoHealth: 100 - (100 * dotsVotes / denominator) * 0.9,
  });
}

export function healthTone(health) {
  if (!Number.isFinite(health) || health < 0 || health > 100) throw new TypeError("Health must be between 0 and 100.");
  return health > 50 ? "green" : health >= 25 ? "yellow" : "red";
}

export function shouldFlashHealth(health) {
  healthTone(health);
  return health < 10;
}
