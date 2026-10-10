import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DataValidationError } from "../model.js";
import {
  PACIFIC_TIMEZONE,
  TOTAL_ROUNDS,
  getHealth,
  getMidnightCountdown,
  getVersusState,
  healthTone,
  isSafeSourceUrl,
  nextMidnight,
  shouldFlashHealth,
  validateVersusData,
} from "../versus-model.js";

const start = Date.parse("2026-10-05T00:00:00.000Z");
const dates = Array.from({ length: TOTAL_ROUNDS }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));

function fixture() {
  const tracker = {
    startDate: dates[0], endDate: dates.at(-1), timezone: PACIFIC_TIMEZONE,
    source: "https://x.com/fixture_dots", updatedAt: "1970-01-01T00:00:00.000Z",
    days: dates.map((date, index) => ({ day: index + 1, date, status: "pending", summary: "", tweetUrl: null })),
  };
  const makeTeam = (side) => ({
    team: `Fixture ${side}`, name: `Player ${side}`, handle: `fixture_${side}`,
    profileUrl: `https://x.com/fixture_${side}`, role: "Fixture role", product: "Fixture product",
    avatar: `assets/${side}.jpg`, entriesSource: side === "dots" ? "data.json" : "versus.json#days[].grokbot",
  });
  const versus = {
    startDate: tracker.startDate, endDate: tracker.endDate, timezone: tracker.timezone,
    teams: { dots: makeTeam("dots"), bots: makeTeam("bots") },
    days: dates.map((date, index) => ({ day: index + 1, date, grokbot: [] })),
    updatedAt: "2026-10-10T22:24:48.000Z",
  };
  return { tracker, versus };
}

function dotsResult(raw, day, status, summary = "Explicit reported result") {
  raw.tracker.updatedAt = "2026-11-02T08:00:00.000Z";
  Object.assign(raw.tracker.days[day - 1], { status, summary, tweetUrl: `https://x.com/fixture_dots/status/${day}` });
}

function botsEntry(raw, day, classification, number = `${day}.${raw.versus.days[day - 1].grokbot.length + 1}`) {
  const entry = {
    number, summary: "Fixture reported source entry", tweetUrl: "https://x.com/fixture_bots/status/100",
    postedAt: `${dates[day - 1]}T19:00:00.000Z`, announcedBy: "fixture_bots", potetoUrl: null,
  };
  if (classification !== undefined) entry.status = classification;
  raw.versus.days[day - 1].grokbot.push(entry);
  return entry;
}

function validate(raw) { return validateVersusData(raw.tracker, raw.versus); }

test("the repository's unchanged dual source schema validates without fabricating classification", async () => {
  const [tracker, versus] = await Promise.all([
    readFile(new URL("../data.json", import.meta.url), "utf8"),
    readFile(new URL("../versus.json", import.meta.url), "utf8"),
  ]);
  const rawTracker = JSON.parse(tracker);
  const rawVersus = JSON.parse(versus);
  const data = validateVersusData(rawTracker, rawVersus);
  assert.equal(data.days.length, TOTAL_ROUNDS);
  assert.deepEqual(data.teams, rawVersus.teams);
  const expectedUnknown = rawVersus.days.flatMap((day) => day.grokbot).filter((entry) => entry.status === undefined && entry.type === undefined).length;
  assert.equal(getVersusState(data).totals.bots.unclassified, expectedUnknown);
  assert.equal(data.tracker.days.filter((day) => day.status === "improvement").length, getVersusState(data).totals.dots.confirmedHits);
  assert.equal(JSON.stringify(rawTracker), JSON.stringify(JSON.parse(tracker)));
  assert.equal(JSON.stringify(rawVersus), JSON.stringify(JSON.parse(versus)));
});

test("typed day records count exactly once and numbered prose never turns resets into hits", () => {
  const raw = fixture();
  dotsResult(raw, 1, "improvement", "1.1 A ship; 1.2 Another ship; 1.3 Another ship.");
  dotsResult(raw, 2, "reset", "A reset plus 2.1, 2.2, 2.3 and 2.4 ships.");
  dotsResult(raw, 3, "missed", "An explicitly reported missed day.");
  const data = validate(raw);
  const state = getVersusState(data, "2026-10-09T12:00:00Z");
  assert.equal(state.totals.dots.hits, 1);
  assert.equal(state.totals.dots.resets, 1);
  assert.equal(state.totals.dots.pending, 25);
  assert.equal(state.totals.dots.reported, 3);
  assert.equal(data.days[0].dots.entries[0].number, "1");
  assert.equal(data.days[1].dots.hits, 0);
  assert.equal(data.days[1].dots.resets, 1);
  assert.equal(data.days[2].dots.hits, 0);
});

test("untyped Grok records remain unknown with separate confirmed counts", () => {
  const raw = fixture();
  dotsResult(raw, 1, "improvement");
  botsEntry(raw, 1);
  botsEntry(raw, 1, "improvement");
  botsEntry(raw, 1, "reset");
  const data = validate(raw);
  assert.deepEqual({
    hits: data.days[0].bots.hits, resets: data.days[0].bots.resets,
    confirmedHits: data.days[0].bots.confirmedHits, confirmedResets: data.days[0].bots.confirmedResets,
    unclassified: data.days[0].bots.unclassified,
  }, { hits: null, resets: null, confirmedHits: 1, confirmedResets: 1, unclassified: 1 });
  assert.equal(data.days[0].winner, "unresolved");
  assert.equal(getVersusState(data).totals.bots.hits, null);
  assert.equal(getVersusState(data).totals.bots.confirmedHits, 1);
});

test("round winners compare confirmed improvements, while resets stay separate", () => {
  const raw = fixture();
  dotsResult(raw, 1, "improvement");
  botsEntry(raw, 1, "improvement");
  dotsResult(raw, 2, "reset");
  botsEntry(raw, 2, "improvement");
  dotsResult(raw, 3, "improvement");
  botsEntry(raw, 3, "reset");
  dotsResult(raw, 4, "reset");
  botsEntry(raw, 4, "reset");
  const data = validate(raw);
  assert.deepEqual(data.days.slice(0, 4).map((day) => day.winner), ["draw", "bots", "dots", "draw"]);
  assert.equal(data.days[4].dots.noMove, true);
  assert.equal(data.days[4].bots.noMove, true);
  assert.equal(data.days[4].winner, "draw");
  assert.equal(data.days[4].dots.status, "pending");
});

test("a pending side does not lose a populated round by inference", () => {
  const raw = fixture();
  botsEntry(raw, 1, "improvement");
  assert.equal(validate(raw).days[0].winner, "unresolved");
});

test("an explicit future type field may classify a source without inventing one", () => {
  const raw = fixture();
  dotsResult(raw, 1, "reset");
  const entry = botsEntry(raw, 1);
  entry.type = "reset";
  assert.equal(validate(raw).days[0].bots.resets, 1);
  assert.equal(validate(raw).days[0].bots.entries[0].classification, "reset");
});

test("rounds start and finish at the PT boundary, including the fall DST end date", () => {
  const data = validate(fixture());
  assert.equal(getVersusState(data, "2026-10-05T06:59:59.999Z").round, 0);
  assert.equal(getVersusState(data, "2026-10-05T07:00:00.000Z").round, 1);
  assert.equal(getVersusState(data, "2026-10-10T06:59:59.999Z").round, 5);
  assert.equal(getVersusState(data, "2026-10-10T07:00:00.000Z").round, 6);
  for (const now of ["2026-11-01T07:00:00Z", "2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z", "2026-11-02T07:59:59.999Z"]) {
    const state = getVersusState(data, now);
    assert.equal(state.round, 28);
    assert.equal(state.phase, "active");
    assert.equal(state.finale.status, "ongoing");
  }
  const after = getVersusState(data, "2026-11-02T08:00:00Z");
  assert.equal(after.round, 28);
  assert.equal(after.phase, "after");
  assert.equal(after.today, null);
  assert.equal(after.finale.status, "unresolved");
  assert.equal(after.totals.dots.pending, 28);
});

test("KO is only possible after all 28 days close with classified, reported results", () => {
  const raw = fixture();
  for (let day = 1; day <= TOTAL_ROUNDS; day += 1) dotsResult(raw, day, "missed", "Explicitly reported no improvement.");
  dotsResult(raw, 1, "improvement");
  let data = validate(raw);
  assert.equal(getVersusState(data, "2026-11-02T07:59:59.999Z").finale.status, "ongoing");
  assert.equal(getVersusState(data, "2026-11-02T08:00:00Z").finale.status, "ko");
  assert.equal(getVersusState(data, "2026-11-02T08:00:00Z").finale.winner, "dots");
  botsEntry(raw, 1, "improvement");
  data = validate(raw);
  assert.equal(getVersusState(data, "2026-11-02T08:00:00Z").finale.status, "draw");
  botsEntry(raw, 2);
  data = validate(raw);
  assert.equal(getVersusState(data, "2026-11-02T08:00:00Z").finale.status, "unresolved");
  assert.equal(getVersusState(data, "2026-11-02T08:00:00Z").finale.winner, null);
});

test("PT midnight countdown handles a 23-hour spring day and a 25-hour fall day", () => {
  const spring = getMidnightCountdown("2026-03-08T08:00:00Z");
  assert.equal(spring.currentDate, "2026-03-08");
  assert.equal(spring.nextMidnightAt, "2026-03-09T07:00:00.000Z");
  assert.equal(spring.totalSeconds, 23 * 3600);
  assert.equal(spring.label, "23:00:00");
  const fall = getMidnightCountdown("2026-11-01T07:00:00Z");
  assert.equal(fall.nextMidnightAt, "2026-11-02T08:00:00.000Z");
  assert.equal(fall.totalSeconds, 25 * 3600);
  assert.equal(fall.label, "25:00:00");
  assert.equal(nextMidnight("2026-11-01T08:30:00Z").toISOString(), nextMidnight("2026-11-01T09:30:00Z").toISOString());
});

test("countdown advances to the next PT date at midnight without displaying negative time", () => {
  assert.equal(getMidnightCountdown("2026-10-10T06:59:59.999Z").label, "00:00:01");
  const midnight = getMidnightCountdown("2026-10-10T07:00:00Z");
  assert.equal(midnight.currentDate, "2026-10-10");
  assert.equal(midnight.label, "24:00:00");
  assert.equal(midnight.nextMidnightAt, "2026-10-11T07:00:00.000Z");
  const returned = nextMidnight("2026-10-10T10:00:00Z");
  returned.setTime(0);
  assert.equal(nextMidnight("2026-10-10T10:00:00Z").toISOString(), "2026-10-11T07:00:00.000Z");
});

test("vote health follows the exact opposing-vote formula, including empty polls", () => {
  assert.deepEqual(getHealth(0, 0), {
    dotsVotes: 0, botsVotes: 0, totalVotes: 0, dotsPercent: 0, botsPercent: 0, tiboHealth: 100, potetoHealth: 100,
  });
  const balanced = getHealth(10, 10);
  assert.equal(balanced.tiboHealth, 55);
  assert.equal(balanced.potetoHealth, 55);
  assert.equal(balanced.dotsPercent, 50);
  assert.equal(balanced.botsPercent, 50);
  for (const [dots, bots] of [[3, 7], [999, 1], [1, 999]]) {
    const health = getHealth(dots, bots);
    assert.equal(health.tiboHealth, 100 - (100 * bots / Math.max(dots + bots, 1)) * 0.9);
    assert.equal(health.potetoHealth, 100 - (100 * dots / Math.max(dots + bots, 1)) * 0.9);
    assert.equal(health.totalVotes, dots + bots);
  }
  assert.equal(getHealth(0, 5).tiboHealth, 10);
  assert.equal(getHealth(5, 0).potetoHealth, 10);
  assert.equal(getHealth(0, 5).potetoHealth, 100);
});

test("health color thresholds and flashing threshold are exact", () => {
  assert.equal(healthTone(50.001), "green");
  assert.equal(healthTone(50), "yellow");
  assert.equal(healthTone(25), "yellow");
  assert.equal(healthTone(24.999), "red");
  assert.equal(shouldFlashHealth(10), false);
  assert.equal(shouldFlashHealth(9.999), true);
  // The required vote formula bottoms out at 10, so legitimate votes never flash.
  assert.equal(shouldFlashHealth(getHealth(0, 100).tiboHealth), false);
});

test("invalid votes and health never leak NaN, negative counts, or unsafe integer totals", () => {
  for (const args of [[-1, 1], [1.5, 2], ["1", 2], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER, 1]]) {
    assert.throws(() => getHealth(...args), TypeError);
  }
  for (const value of [-1, 101, NaN, Infinity, "50"]) assert.throws(() => healthTone(value), TypeError);
  assert.throws(() => nextMidnight(new Date("invalid")), TypeError);
  assert.throws(() => getVersusState(validate(fixture()), new Date("invalid")), TypeError);
});

test("source links accept ordinary public HTTPS X URLs and reject executable or disguised links", () => {
  assert.equal(isSafeSourceUrl("https://x.com/poteto"), true);
  assert.equal(isSafeSourceUrl("https://www.x.com/poteto/status/123", true), true);
  for (const value of ["javascript:alert(1)", "data:text/html,x", "https://x.com.evil.test/poteto", "https://user:pw@x.com/poteto", "http://x.com/poteto", "https://x.com/poteto?q=1", "https://x.com/poteto#x", "https://x.co\nm/poteto", "/poteto/status/123"]) {
    assert.equal(isSafeSourceUrl(value), false);
  }
  assert.equal(isSafeSourceUrl("https://x.com/poteto", true), false);
});

const invalidCases = [
  ["mismatched timezone", (raw) => { raw.versus.timezone = "UTC"; }],
  ["mismatched dates", (raw) => { raw.versus.startDate = "2026-10-06"; }],
  ["missing teams", (raw) => { delete raw.versus.teams; }],
  ["extra root fields", (raw) => { raw.versus.injected = true; }],
  ["missing rounds", (raw) => { raw.versus.days.pop(); }],
  ["misaligned round", (raw) => { raw.versus.days[0].day = 2; }],
  ["misaligned date", (raw) => { raw.versus.days[0].date = "2026-10-06"; }],
  ["unsafe avatar path", (raw) => { raw.versus.teams.bots.avatar = "../secret.jpg"; }],
  ["unsafe team profile", (raw) => { raw.versus.teams.bots.profileUrl = "javascript:alert(1)"; }],
  ["nonexistent entries source", (raw) => { raw.versus.teams.bots.entriesSource = "data.json#invented"; }],
  ["unsafe entry link", (raw) => { botsEntry(raw, 1).tweetUrl = "https://evil.test/123"; }],
  ["unsafe corroboration link", (raw) => { botsEntry(raw, 1).potetoUrl = "javascript:alert(1)"; }],
  ["wrong numbered round", (raw) => { botsEntry(raw, 1).number = "2.1"; }],
  ["duplicate update numbers", (raw) => { botsEntry(raw, 1); botsEntry(raw, 1, undefined, "1.1"); }],
  ["missing explicit timestamp offset", (raw) => { botsEntry(raw, 1).postedAt = "2026-10-05T12:00:00"; }],
  ["invalid timestamp date", (raw) => { botsEntry(raw, 1).postedAt = "2026-02-30T12:00:00Z"; }],
  ["invalid timestamp clock", (raw) => { botsEntry(raw, 1).postedAt = "2026-10-05T24:00:00Z"; }],
  ["invalid timestamp offset", (raw) => { botsEntry(raw, 1).postedAt = "2026-10-05T12:00:00+14:30"; }],
  ["source posted in another PT day", (raw) => { botsEntry(raw, 1).postedAt = "2026-10-05T06:59:59Z"; }],
  ["unknown explicit classification", (raw) => { botsEntry(raw, 1, "ship"); }],
  ["conflicting explicit classification", (raw) => { botsEntry(raw, 1, "reset").type = "improvement"; }],
];

for (const [label, mutate] of invalidCases) {
  test(`VERSUS validation rejects ${label}`, () => {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => validate(raw), DataValidationError);
  });
}

test("validated metadata, entries, rounds and state cannot be changed accidentally", () => {
  const raw = fixture();
  dotsResult(raw, 1, "improvement");
  botsEntry(raw, 1);
  const data = validate(raw);
  raw.versus.teams.bots.name = "Changed";
  raw.versus.days[0].grokbot[0].summary = "Changed";
  assert.equal(data.teams.bots.name, "Player bots");
  assert.equal(data.days[0].bots.entries[0].summary, "Fixture reported source entry");
  for (const value of [data, data.teams, data.teams.bots, data.days, data.days[0], data.days[0].dots, data.days[0].bots.entries, data.days[0].bots.entries[0], getVersusState(data).totals]) {
    assert.ok(Object.isFrozen(value));
  }
});

test("validation rejects getters without evaluating them", () => {
  const raw = fixture();
  Object.defineProperty(raw.versus.teams.bots, "name", { get() { throw new Error("Getter must not run"); }, enumerable: true });
  assert.throws(() => validate(raw), DataValidationError);
});
