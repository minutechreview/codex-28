/** Pure data/date logic. Rendering must use textContent for public data strings. */
export const TOTAL_DAYS = 28;
export const NEVER_UPDATED_AT = "1970-01-01T00:00:00.000Z";
export const STALE_AFTER_HOURS = 24;
export const STATUSES = Object.freeze(["improvement", "reset", "pending", "missed"]);

const DAY_MS = 86_400_000;
const ROOT_KEYS = ["startDate", "endDate", "timezone", "source", "days", "updatedAt"];
const DAY_KEYS = ["day", "date", "status", "summary", "tweetUrl"];

export class DataValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DataValidationError";
  }
}

function fail(message) {
  throw new DataValidationError(message);
}

function assertRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain JSON object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) {
    fail(`${label} has missing or unexpected fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      fail(`${label} must contain plain JSON values.`);
    }
  }
}

function assertDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must use YYYY-MM-DD.`);
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    fail(`${label} is not a real calendar date.`);
  }
  return timestamp;
}

function assertTimestamp(value) {
  if (typeof value !== "string") fail("updatedAt must be an ISO timestamp with a timezone.");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail("updatedAt must be an ISO timestamp with a timezone.");
  assertDate(match[1], "updatedAt date");
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    fail("updatedAt contains an invalid clock time.");
  }
  if (match[5] !== "Z") {
    const offsetHour = Number(match[5].slice(1, 3));
    const offsetMinute = Number(match[5].slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      fail("updatedAt contains an invalid timezone offset.");
    }
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail("updatedAt is not a valid timestamp.");
  return timestamp;
}

function assertTimezone(value) {
  if (typeof value !== "string" || value.length > 100 || value.trim() !== value || !value) {
    fail("timezone must be a valid IANA timezone.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
  } catch {
    fail("timezone must be a valid IANA timezone.");
  }
  if (/^[+-]/.test(value)) fail("timezone must be a named IANA timezone.");
}

/** Allow ordinary HTTPS X profile/post URLs only; never javascript/data URLs. */
function assertXUrl(value, label, postOnly = false) {
  if (typeof value !== "string" || value.length > 250 || /\s/.test(value)) {
    fail(`${label} must be a plain HTTPS X URL.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be a plain HTTPS X URL.`);
  }
  const pathPattern = postOnly
    ? /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/
    : /^\/[A-Za-z0-9_]{1,15}(?:\/status\/\d+)?\/?$/;
  if (
    url.protocol !== "https:" ||
    !["x.com", "www.x.com"].includes(url.hostname) ||
    url.username || url.password || url.port || url.search || url.hash ||
    !pathPattern.test(url.pathname)
  ) {
    fail(`${label} must be a plain HTTPS X ${postOnly ? "post" : "profile or post"} URL.`);
  }
}

/** Return an immutable validated copy, or throw a safe DataValidationError. */
export function validateData(raw) {
  assertRecord(raw, ROOT_KEYS, "Tracker data");
  const startTimestamp = assertDate(raw.startDate, "startDate");
  const endTimestamp = assertDate(raw.endDate, "endDate");
  if (endTimestamp - startTimestamp !== (TOTAL_DAYS - 1) * DAY_MS) {
    fail("startDate and endDate must describe exactly 28 consecutive days.");
  }
  assertTimezone(raw.timezone);
  assertXUrl(raw.source, "source");
  const updatedTimestamp = assertTimestamp(raw.updatedAt);
  if (!Array.isArray(raw.days) || raw.days.length !== TOTAL_DAYS) {
    fail("days must contain exactly 28 entries.");
  }
  const days = raw.days.map((entry, index) => {
    const label = `Day ${index + 1}`;
    assertRecord(entry, DAY_KEYS, label);
    if (!Number.isInteger(entry.day) || entry.day !== index + 1) {
      fail(`${label} must have its consecutive day number.`);
    }
    const expectedDate = new Date(startTimestamp + index * DAY_MS).toISOString().slice(0, 10);
    if (entry.date !== expectedDate) fail(`${label} must have its matching consecutive date.`);
    if (!STATUSES.includes(entry.status)) fail(`${label} has an unknown status.`);
    if (typeof entry.summary !== "string" || entry.summary.length > 500) {
      fail(`${label} summary must be text of at most 500 characters.`);
    }
    if (entry.status !== "pending" && !entry.summary.trim()) {
      fail(`${label} needs a summary explaining its reported result.`);
    }
    if (entry.tweetUrl !== null) assertXUrl(entry.tweetUrl, `${label} tweetUrl`, true);
    return Object.freeze({
      day: entry.day,
      date: entry.date,
      status: entry.status,
      summary: entry.summary,
      tweetUrl: entry.tweetUrl,
    });
  });
  if (updatedTimestamp === 0 && days.some((entry) => entry.status !== "pending")) {
    fail("Reported results need a real updatedAt timestamp.");
  }
  return Object.freeze({
    startDate: raw.startDate,
    endDate: raw.endDate,
    timezone: raw.timezone,
    source: raw.source,
    days: Object.freeze(days),
    updatedAt: raw.updatedAt,
  });
}

function asDate(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid date or timestamp.");
  return date;
}

/** The calendar date in the tracker timezone, independent of browser locale. */
export function dateInTimezone(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(asDate(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year.padStart(4, "0")}-${values.month}-${values.day}`;
}

/** Never infer a missed result from time passing. Pending stays pending. */
export function getTrackerState(data, now = new Date()) {
  const currentDate = dateInTimezone(now, data.timezone);
  const phase = currentDate < data.startDate ? "before" : currentDate > data.endDate ? "after" : "active";
  const day = phase === "before" ? 0 : phase === "after" ? TOTAL_DAYS
    : Math.round((Date.parse(`${currentDate}T00:00:00.000Z`) - Date.parse(`${data.startDate}T00:00:00.000Z`)) / DAY_MS) + 1;
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  let awaitingReports = 0;
  let futurePending = 0;
  let elapsedDays = 0;
  for (const entry of data.days) {
    counts[entry.status] += 1;
    if (entry.date <= currentDate) elapsedDays += 1;
    if (entry.status === "pending") {
      if (entry.date <= currentDate) awaitingReports += 1;
      else futurePending += 1;
    }
  }
  return {
    phase,
    day,
    currentDate,
    today: phase === "active" ? data.days[day - 1] : null,
    counts,
    awaitingReports,
    futurePending,
    elapsedDays,
  };
}

/** Epoch is an explicit never-updated marker, not a claimed reporting date. */
export function freshness(data, now = new Date()) {
  const updatedTimestamp = Date.parse(data.updatedAt);
  if (updatedTimestamp === 0) {
    return { status: "never", updatedAt: data.updatedAt, ageHours: null };
  }
  const ageHours = (asDate(now).getTime() - updatedTimestamp) / 3_600_000;
  const status = ageHours < -5 / 60 ? "future" : ageHours >= STALE_AFTER_HOURS ? "stale" : "fresh";
  return { status, updatedAt: data.updatedAt, ageHours };
}
