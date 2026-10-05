import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DataValidationError,
  NEVER_UPDATED_AT,
  TOTAL_DAYS,
  dateInTimezone,
  freshness,
  getTrackerState,
  validateData,
} from "../model.js";

// Logic tests own a stable fixture. Editing the live scoreboard must not change
// boundary/count expectations or prevent a legitimate data-only deployment.
const fixtureStart = Date.parse("2026-10-05T00:00:00.000Z");
const initialRaw = {
  startDate: "2026-10-05",
  endDate: "2026-11-01",
  timezone: "America/Los_Angeles",
  source: "https://x.com/thsottiaux",
  days: Array.from({ length: TOTAL_DAYS }, (_, index) => ({
    day: index + 1,
    date: new Date(fixtureStart + index * 86_400_000).toISOString().slice(0, 10),
    status: "pending",
    summary: "",
    tweetUrl: null,
  })),
  updatedAt: NEVER_UPDATED_AT,
};
const initial = validateData(initialRaw);
const copy = () => structuredClone(initialRaw);
const at = (iso) => new Date(iso);

test("the actual public data.json is valid independently of its recorded results", async () => {
  const publicRaw = JSON.parse(await readFile(new URL("../data.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateData(publicRaw));
});

test("the pending fixture has all 28 results pending and no claimed update", () => {
  assert.equal(initial.startDate, "2026-10-05");
  assert.equal(initial.endDate, "2026-11-01");
  assert.equal(initial.timezone, "America/Los_Angeles");
  assert.equal(initial.source, "https://x.com/thsottiaux");
  assert.equal(initial.days.length, TOTAL_DAYS);
  assert.ok(initial.days.every((day) => day.status === "pending" && day.summary === "" && day.tweetUrl === null));
  assert.equal(initial.updatedAt, NEVER_UPDATED_AT);
  assert.deepEqual(freshness(initial, at("2026-10-05T12:00:00Z")), {
    status: "never", updatedAt: NEVER_UPDATED_AT, ageHours: null,
  });
});

test("timezone date conversion uses Los Angeles midnight, independently of UTC day", () => {
  assert.equal(dateInTimezone(at("2026-10-04T06:59:59.999Z"), initial.timezone), "2026-10-03");
  assert.equal(dateInTimezone(at("2026-10-04T07:00:00.000Z"), initial.timezone), "2026-10-04");
  assert.equal(dateInTimezone(at("2026-10-05T06:59:59.999Z"), initial.timezone), "2026-10-04");
  assert.equal(dateInTimezone(at("2026-10-05T07:00:00.000Z"), initial.timezone), "2026-10-05");
});

test("before the window the counter is zero, with all pending dates in the future", () => {
  const state = getTrackerState(initial, at("2026-10-05T06:59:59.999Z"));
  assert.equal(state.phase, "before");
  assert.equal(state.day, 0);
  assert.equal(state.today, null);
  assert.equal(state.awaitingReports, 0);
  assert.equal(state.futurePending, 28);
  assert.equal(state.elapsedDays, 0);
});

test("day 1 begins at midnight PDT and includes today among awaiting reports", () => {
  const state = getTrackerState(initial, at("2026-10-05T07:00:00.000Z"));
  assert.equal(state.phase, "active");
  assert.equal(state.day, 1);
  assert.equal(state.today.day, 1);
  assert.equal(state.today.status, "pending");
  assert.equal(state.awaitingReports, 1);
  assert.equal(state.futurePending, 27);
  assert.equal(state.elapsedDays, 1);
  assert.deepEqual(state.counts, { improvement: 0, reset: 0, pending: 28, missed: 0 });
});

test("day 28 remains active through the complete local end date", () => {
  for (const moment of ["2026-11-01T07:00:00.000Z", "2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z", "2026-11-02T07:59:59.999Z"]) {
    const state = getTrackerState(initial, at(moment));
    assert.equal(state.phase, "active");
    assert.equal(state.day, 28);
    assert.equal(state.today.date, "2026-11-01");
    assert.equal(state.awaitingReports, 28);
    assert.equal(state.futurePending, 0);
  }
});

test("after the window the counter stops at 28 and elapsed pending results never become missed", () => {
  for (const moment of ["2026-11-02T08:00:00.000Z", "2028-06-01T12:00:00.000Z"]) {
    const state = getTrackerState(initial, at(moment));
    assert.equal(state.phase, "after");
    assert.equal(state.day, 28);
    assert.equal(state.today, null);
    assert.equal(state.counts.pending, 28);
    assert.equal(state.counts.missed, 0);
    assert.equal(state.awaitingReports, 28);
    assert.equal(state.futurePending, 0);
    assert.equal(state.elapsedDays, 28);
  }
});

test("only explicit reported statuses affect counters", () => {
  const data = copy();
  data.updatedAt = "2026-10-07T18:00:00.000Z";
  data.days[0] = { ...data.days[0], status: "improvement", summary: "Example verified improvement", tweetUrl: "https://x.com/thsottiaux/status/123456789" };
  data.days[1] = { ...data.days[1], status: "reset", summary: "Example verified reset" };
  data.days[2] = { ...data.days[2], status: "missed", summary: "Example manually confirmed missed result" };
  const state = getTrackerState(validateData(data), at("2026-10-09T01:00:00Z"));
  assert.equal(state.day, 4);
  assert.deepEqual(state.counts, { improvement: 1, reset: 1, pending: 25, missed: 1 });
  assert.equal(state.awaitingReports, 1);
  assert.equal(state.futurePending, 24);
});

test("freshness exposes never, fresh, stale, and future timestamps", () => {
  const data = copy();
  data.updatedAt = "2026-10-05T12:00:00.000Z";
  const validated = validateData(data);
  assert.equal(freshness(validated, at("2026-10-05T12:00:00Z")).status, "fresh");
  assert.equal(freshness(validated, at("2026-10-06T11:59:59Z")).status, "fresh");
  assert.equal(freshness(validated, at("2026-10-06T12:00:00Z")).status, "stale");
  assert.equal(freshness(validated, at("2026-10-05T11:54:59Z")).status, "future");
  assert.equal(freshness(validated, at("2026-10-05T11:56:00Z")).status, "fresh");
});

test("timestamps with an explicit ISO offset are accepted without date ambiguity", () => {
  const data = copy();
  data.updatedAt = "2026-10-05T05:00:00-07:00";
  assert.equal(freshness(validateData(data), at("2026-10-05T12:00:00Z")).ageHours, 0);
});

const invalidCases = [
  ["missing key", (data) => { delete data.source; }],
  ["unexpected key", (data) => { data.other = true; }],
  ["too few days", (data) => { data.days.pop(); }],
  ["extra days", (data) => { data.days.push(data.days[0]); }],
  ["nonconsecutive number", (data) => { data.days[2].day = 4; }],
  ["fractional day", (data) => { data.days[2].day = 3.5; }],
  ["wrong date", (data) => { data.days[2].date = "2026-10-08"; }],
  ["wrong end date", (data) => { data.endDate = "2026-11-02"; }],
  ["invalid calendar date", (data) => { data.startDate = "2026-02-30"; }],
  ["unknown timezone", (data) => { data.timezone = "Mars/Olympus_Mons"; }],
  ["numeric offset timezone", (data) => { data.timezone = "+01:00"; }],
  ["unknown status", (data) => { data.days[0].status = "success"; }],
  ["nontext summary", (data) => { data.days[0].summary = { html: "bad" }; }],
  ["oversized summary", (data) => { data.days[0].summary = "x".repeat(501); }],
  ["empty reported summary", (data) => { data.days[0].status = "reset"; data.updatedAt = "2026-10-05T12:00:00Z"; }],
  ["reported result with never-updated marker", (data) => { data.days[0].status = "reset"; data.days[0].summary = "Reported reset"; }],
  ["unsafe source", (data) => { data.source = "javascript:alert(1)"; }],
  ["unrelated source host", (data) => { data.source = "https://x.com.example.org/thsottiaux"; }],
  ["credential URL", (data) => { data.source = "https://user:password@x.com/thsottiaux"; }],
  ["source query string", (data) => { data.source = "https://x.com/thsottiaux?tracking=1"; }],
  ["URL containing control whitespace", (data) => { data.source = "https://x.co\nm/thsottiaux"; }],
  ["relative tweet URL", (data) => { data.days[0].tweetUrl = "/thsottiaux/status/123"; }],
  ["profile as tweet URL", (data) => { data.days[0].tweetUrl = "https://x.com/thsottiaux"; }],
  ["blank tweet URL", (data) => { data.days[0].tweetUrl = ""; }],
  ["missing timestamp timezone", (data) => { data.updatedAt = "2026-10-05T12:00:00"; }],
  ["timestamp calendar rollover", (data) => { data.updatedAt = "2026-02-30T12:00:00Z"; }],
  ["timestamp hour rollover", (data) => { data.updatedAt = "2026-10-05T24:00:00Z"; }],
  ["invalid timestamp offset", (data) => { data.updatedAt = "2026-10-05T12:00:00+14:30"; }],
];

for (const [label, mutate] of invalidCases) {
  test(`validation rejects ${label}`, () => {
    const data = copy();
    mutate(data);
    assert.throws(() => validateData(data), DataValidationError);
  });
}

test("validation rejects arrays, null, non-JSON objects, getters, and prototype fields", () => {
  for (const value of [null, [], "{}", new Date()]) {
    assert.throws(() => validateData(value), DataValidationError);
  }
  const prototypeField = JSON.parse(JSON.stringify(initialRaw).replace('"startDate":', '"__proto__":{},"startDate":'));
  assert.throws(() => validateData(prototypeField), DataValidationError);
  const getterData = copy();
  Object.defineProperty(getterData, "source", { get() { throw new Error("must not run"); }, enumerable: true });
  assert.throws(() => validateData(getterData), DataValidationError);
});

test("validated data cannot be altered accidentally by the renderer", () => {
  const raw = copy();
  const data = validateData(raw);
  raw.days[0].status = "reset";
  assert.equal(data.days[0].status, "pending");
  assert.ok(Object.isFrozen(data));
  assert.ok(Object.isFrozen(data.days));
  assert.ok(Object.isFrozen(data.days[0]));
});

test("invalid current time is rejected instead of producing an incorrect day", () => {
  assert.throws(() => getTrackerState(initial, new Date("invalid")), TypeError);
});
