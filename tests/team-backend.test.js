import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { createVotingWorker, SOURCE_URL, SITE_ORIGIN } from "../backend/worker.js";
import { SQLiteD1 } from "./helpers/sqlite-d1.js";
import { TeamSQLiteD1, teamMigration } from "./helpers/team-sqlite-d1.js";

// Reuse only the established published schema/calendar. Fixture publication is stable across data edits.
const source = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));
source.days = source.days.map((entry, index) => ({ ...entry, status: index === 0 ? "improvement" : "pending",
  summary: index === 0 ? "Published fixture for Day 1." : "", tweetUrl: null }));
source.updatedAt = "2026-10-08T15:45:00.000Z";
const DAY = "2026-10-10";
const BROWSER = "0a754e8d-5799-4dca-aa84-54bcaed91d12";
const APPROVAL = "codex-28:2026-10-05:day-1";

function setup(t, options = {}) {
  const db = new TeamSQLiteD1();
  t.after(() => db.close());
  const context = { data: structuredClone(source), date: new Date("2026-10-10T20:00:00Z"), calls: [] };
  const worker = createVotingWorker({ now: () => context.date,
    fetchSource: async (url, init) => { context.calls.push({ url, init }); return Response.json(context.data); }, ...options });
  const call = async (day = DAY, { method = "GET", voterId = BROWSER, choice = "dots", body,
    headers, origin = SITE_ORIGIN, query, rawPath, env = { DB: db } } = {}) => {
    const url = `https://voting.example${rawPath ?? `/teams/${encodeURIComponent(day)}`}${query ??
      (method === "GET" && voterId !== null ? `?voterId=${encodeURIComponent(voterId)}` : "")}`;
    const requestHeaders = new Headers(headers);
    if (origin !== null) requestHeaders.set("Origin", origin);
    const init = { method, headers: requestHeaders };
    if (method === "POST") {
      if (!requestHeaders.has("Content-Type")) requestHeaders.set("Content-Type", "application/json");
      init.body = body ?? JSON.stringify({ voterId, choice });
    }
    const response = await worker.fetch(new Request(url, init), env);
    return { response, status: response.status, payload: response.status === 204 ? null : await response.json() };
  };
  return { db, context, call, worker };
}

test("team counts persist one device's original choice without exposing an identity", async t => {
  const { call, db } = setup(t);
  assert.deepEqual((await call(DAY, { voterId: null, origin: null })).payload,
    { day: DAY, open: true, dotsVotes: 0, botsVotes: 0, totalVotes: 0, yourVote: null });
  const first = await call(DAY, { method: "POST" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.payload, { day: DAY, open: true, dotsVotes: 1, botsVotes: 0,
    totalVotes: 1, yourVote: "dots", accepted: true });
  const duplicate = await call(DAY, { method: "POST", voterId: BROWSER.toUpperCase(), choice: "bots" });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.payload.accepted, false);
  assert.equal(duplicate.payload.yourVote, "dots");
  assert.equal(duplicate.payload.totalVotes, 1);
  assert.equal((await call(DAY, { voterId: BROWSER.toUpperCase() })).payload.yourVote, "dots");
  assert.equal((await call(DAY, { voterId: randomUUID() })).payload.yourVote, null);
  assert.equal((await call(DAY, { voterId: null })).payload.yourVote, null);
  const row = db.database.prepare("SELECT * FROM team_votes").get();
  assert.match(row.voter_hash, /^[a-f0-9]{64}$/);
  assert.equal(Object.values(row).includes(BROWSER), false);
  assert.equal(Object.keys(first.payload).some(key => key.includes("hash") || key.includes("voterId")), false);
});

test("the additive migration leaves seeded approval rows, schema and API results intact", async t => {
  const legacy = new SQLiteD1();
  t.after(() => legacy.close());
  const worker = createVotingWorker({ now: () => new Date("2026-10-10T20:00:00Z"),
    fetchSource: async () => Response.json(source) });
  const legacyRequest = method => new Request(`https://voting.example/polls/${encodeURIComponent(APPROVAL)}?${method === "GET" ? `voterId=${BROWSER}` : ""}`, {
    method, headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ voterId: BROWSER, choice: "approve" }) } : {}),
  });
  // POST has no query string, preserving the legacy route's strict contract.
  const before = await worker.fetch(new Request(`https://voting.example/polls/${encodeURIComponent(APPROVAL)}`, {
    method: "POST", headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ voterId: BROWSER, choice: "approve" }),
  }), { DB: legacy });
  assert.equal((await before.json()).accepted, true);
  const legacyRows = () => ({ polls: legacy.database.prepare("SELECT * FROM polls").all().map(row => ({ ...row })),
    votes: legacy.database.prepare("SELECT * FROM votes").all().map(row => ({ ...row })),
    schema: legacy.database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name IN ('polls','votes','votes_count_insert','votes_immutable','votes_count_delete') ORDER BY name")
      .all().map(row => ({ ...row })) });
  const snapshot = legacyRows();
  legacy.database.exec(teamMigration);
  const team = await worker.fetch(new Request(`https://voting.example/teams/${DAY}`, {
    method: "POST", headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ voterId: BROWSER, choice: "bots" }),
  }), { DB: legacy });
  assert.equal((await team.json()).botsVotes, 1);
  legacy.database.exec(teamMigration);
  assert.deepEqual(legacyRows(), snapshot);
  assert.deepEqual(await (await worker.fetch(legacyRequest("GET"), { DB: legacy })).json(),
    { pollId: APPROVAL, approve: 1, notConvinced: 0, total: 1, yourVote: "approve" });
  const teamHash = legacy.database.prepare("SELECT voter_hash FROM team_votes").get().voter_hash;
  assert.notEqual(teamHash, snapshot.votes[0].voter_hash);
});

test("team preference opens on the current PT day even while its update remains pending", async t => {
  const { call, worker, db } = setup(t);
  assert.equal((await call(DAY, { method: "POST" })).payload.accepted, true);
  const approval = await worker.fetch(new Request(`https://voting.example/polls/${encodeURIComponent("codex-28:2026-10-10:day-6")}`), { DB: db });
  assert.equal(approval.status, 404);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM votes").get().n, 0);
});

test("strict team JSON, UUIDv4, query and method checks reject arbitrary visitor writes", async t => {
  const { call, context, db } = setup(t);
  for (const body of ["{", "null", "[]", JSON.stringify({ voterId: BROWSER }),
    JSON.stringify({ voterId: BROWSER, choice: "dots", day: DAY }),
    JSON.stringify({ voterId: BROWSER, choice: "approve" }), JSON.stringify({ voterId: BROWSER, choice: "DOTS" }),
    JSON.stringify({ voterId: BROWSER, choice: null }), JSON.stringify({ voterId: BROWSER, choice: {} }),
    JSON.stringify({ voterId: "0a754e8d-5799-1dca-aa84-54bcaed91d12", choice: "dots" }),
    JSON.stringify({ voterId: "0a754e8d-5799-4dca-0a84-54bcaed91d12", choice: "dots" }),
    JSON.stringify({ voterId: 123, choice: "dots" }), JSON.stringify({ voterId: null, choice: "bots" })]) {
    assert.equal((await call(DAY, { method: "POST", body })).status, 400, body);
  }
  for (const voterId of ["", "invalid"]) assert.equal((await call(DAY, { voterId })).status, 400);
  assert.equal((await call(DAY, { query: `?voterId=${BROWSER}&voterId=${BROWSER}` })).status, 400);
  assert.equal((await call(DAY, { query: "?day=2026-10-11" })).status, 400);
  assert.equal((await call(DAY, { method: "POST", query: `?voterId=${BROWSER}` })).status, 400);
  assert.equal((await call(DAY, { method: "POST", headers: { "Content-Type": "text/plain" } })).status, 415);
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const output = await call(DAY, { method });
    assert.equal(output.status, 405); assert.equal(output.response.headers.get("Allow"), "GET, POST, OPTIONS");
  }
  assert.equal(context.calls.length, 0);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM team_votes").get().n, 0);
});

test("request bytes and malformed calendar routes are bounded before source/database access", async t => {
  const { call, worker, context, db } = setup(t);
  assert.equal((await call(DAY, { method: "POST", body: "x".repeat(1025) })).status, 413);
  assert.equal((await call(DAY, { method: "POST", headers: { "Content-Length": "10000" } })).status, 413);
  assert.equal((await call(DAY, { method: "POST", headers: { "Content-Length": "abc" } })).status, 413);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(600)); controller.enqueue(new Uint8Array(600)); controller.close();
  } });
  assert.equal((await worker.fetch(new Request(`https://voting.example/teams/${DAY}`, {
    method: "POST", body: stream, duplex: "half", headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
  }), { DB: db })).status, 413);
  for (const day of ["2026-13-10", "2026-02-30", "2026-10-32", "2026-10-10' OR 1=1", "2026-10-1", "day-6"]) {
    assert.equal((await call(day)).status, 404, day);
  }
  assert.equal((await call(DAY, { rawPath: "/teams/%E0%A4%A" })).status, 400);
  assert.equal((await call(DAY, { rawPath: "/teams/2026-10-10/extra" })).status, 404);
  assert.equal(context.calls.length, 0);
});

test("team CORS remains exact-origin and never grants credentials or arbitrary headers", async t => {
  const { call, context } = setup(t);
  for (const origin of ["https://evil.example", "https://minutechreview.github.io.evil.example", "http://minutechreview.github.io", "null", null]) {
    const output = await call(DAY, { method: "POST", origin });
    assert.equal(output.status, 403); assert.equal(output.response.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(context.calls.length, 0);
  const preflight = await call(DAY, { method: "OPTIONS", headers: {
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.response.headers.get("Access-Control-Allow-Origin"), SITE_ORIGIN);
  assert.equal(preflight.response.headers.get("Access-Control-Allow-Credentials"), null);
  assert.equal(preflight.response.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  assert.equal((await call(DAY, { method: "OPTIONS", headers: {
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization",
  } })).status, 403);
  assert.equal((await call(DAY, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE" } })).status, 403);
  const output = await call();
  assert.equal(output.response.headers.get("Cache-Control"), "no-store");
  assert.equal(output.response.headers.get("Vary"), "Origin");
  assert.equal(output.response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("team dates come from the validated fixed published source and a captured server timestamp", async t => {
  const { call, context } = setup(t);
  await call(); await call(DAY, { method: "POST" });
  for (const { url, init } of context.calls) {
    assert.equal(url.split("?")[0], SOURCE_URL); assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal); assert.equal(init.cf, undefined);
  }
  context.data = { ...context.data, teams: {} };
  const invalid = await call(DAY, { method: "POST", voterId: randomUUID() });
  assert.equal(invalid.status, 503); assert.equal(invalid.payload.error.code, "updates_unavailable");
  const rollover = setup(t);
  rollover.context.date = new Date("2026-10-11T06:59:59.999Z");
  const worker = createVotingWorker({ now: () => rollover.context.date, fetchSource: async () => {
    rollover.context.date = new Date("2026-10-11T07:00:00.000Z"); return Response.json(source);
  } });
  const response = await worker.fetch(new Request(`https://voting.example/teams/${DAY}`, {
    method: "POST", headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ voterId: BROWSER, choice: "dots" }),
  }), { DB: rollover.db });
  assert.equal(response.status, 200);
  assert.equal(rollover.db.database.prepare("SELECT created_at FROM team_votes").get().created_at,
    Date.parse("2026-10-11T06:59:59.999Z"));
});

test("source network, redirect, malformed, oversized and wrong-calendar failures cannot write", async t => {
  const wrongWindow = structuredClone(source);
  wrongWindow.timezone = "UTC";
  for (const fetchSource of [async () => { throw new Error("Network"); }, async () => new Response("bad json"),
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response(null, { status: 302, headers: { Location: "https://untrusted.example/data.json" } }),
    async () => new Response(" ".repeat(65537)), async () => Response.json(wrongWindow)]) {
    const { call, db } = setup(t, { fetchSource });
    const output = await call(DAY, { method: "POST" });
    assert.equal(output.status, 503); assert.equal(output.payload.error.code, "updates_unavailable");
    assert.equal(output.response.headers.get("Retry-After"), "5");
    assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM team_votes").get().n, 0);
  }
});

test("only the current server PT day can vote; the closed tracker returns open:false", async t => {
  const { call, context, db } = setup(t);
  for (const day of ["2026-10-09", "2026-10-11", "2026-10-04", "2026-11-02"]) {
    const output = await call(day, { method: "POST" });
    assert.equal(output.status, 410); assert.equal(output.payload.error.code, "day_closed");
  }
  context.date = new Date("2026-10-05T06:59:59Z");
  assert.deepEqual((await call("2026-10-04")).payload,
    { day: "2026-10-04", open: false, dotsVotes: 0, botsVotes: 0, totalVotes: 0, yourVote: null });
  assert.equal((await call("2026-10-04", { method: "POST" })).status, 410);
  context.date = new Date("2026-11-02T08:00:00Z");
  assert.equal((await call("2026-11-02")).payload.open, false);
  assert.equal((await call("2026-11-01", { method: "POST" })).status, 410);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM team_votes").get().n, 0);
});

test("Pacific midnight grants a new day, including the final 25-hour DST day", async t => {
  const { call, context, db } = setup(t);
  context.date = new Date("2026-10-11T06:59:59.999Z");
  assert.equal((await call(DAY, { method: "POST" })).payload.accepted, true);
  assert.equal((await call("2026-10-11", { method: "POST" })).status, 410);
  context.date = new Date("2026-10-11T07:00:00Z");
  assert.equal((await call(DAY, { method: "POST" })).status, 410);
  assert.equal((await call("2026-10-11", { method: "POST", choice: "bots" })).payload.accepted, true);
  context.date = new Date("2026-11-01T06:59:59.999Z");
  assert.equal((await call("2026-11-01", { method: "POST" })).status, 410);
  context.date = new Date("2026-11-01T07:00:00Z");
  assert.equal((await call("2026-11-01", { method: "POST" })).payload.accepted, true);
  for (const timestamp of ["2026-11-01T08:59:59Z", "2026-11-01T09:00:00Z", "2026-11-02T07:59:59.999Z"]) {
    context.date = new Date(timestamp);
    const repeat = await call("2026-11-01", { method: "POST", choice: "bots" });
    assert.equal(repeat.payload.accepted, false, timestamp); assert.equal(repeat.payload.yourVote, "dots");
  }
  context.date = new Date("2026-11-02T08:00:00Z");
  assert.equal((await call("2026-11-01", { method: "POST" })).status, 410);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM team_votes").get().n, 3);
});

test("missing migrations, malformed database responses and failures are retryable without success claims", async t => {
  const { call, db } = setup(t);
  const legacyOnly = new SQLiteD1(); t.after(() => legacyOnly.close());
  const failing = { prepare() { throw new Error("Offline"); } };
  const corrupt = { prepare() { return { bind() { return { first: async () => ({ dots_votes: -1, bots_votes: 1 }) }; } }; } };
  const falseBatch = { prepare: db.prepare.bind(db), batch: async () => [{ success: false }] };
  for (const env of [{}, { DB: failing }, { DB: legacyOnly }, { DB: falseBatch }]) {
    const output = await call(DAY, { method: "POST", env });
    assert.equal(output.status, 503); assert.equal(output.payload.error.code, "voting_unavailable");
    assert.equal(output.response.headers.get("Retry-After"), "5"); assert.equal(output.payload.accepted, undefined);
  }
  assert.equal((await call(DAY, { env: { DB: corrupt } })).status, 503);
  const sessions = [];
  const primary = { withSession(value) { sessions.push(value); return db; } };
  assert.equal((await call(DAY, { env: { DB: primary } })).status, 200);
  assert.equal((await call(DAY, { method: "POST", env: { DB: primary } })).status, 200);
  assert.deepEqual(sessions, ["first-primary", "first-primary"]);
});

test("real SQL rejects invalid choices, identities, calendar rows and changing recorded votes", async t => {
  const { call, db } = setup(t);
  await call(DAY, { method: "POST" });
  for (const [date, day] of [[DAY, 7], ["2026-10-xx", 1], ["2026-10-32", 1], ["2026-10-05junk", 1], [null, 1], ["2026-10-05", 1.5]]) {
    assert.throws(() => db.database.prepare("INSERT INTO team_polls(poll_date,day) VALUES (?,?)").run(date, day));
  }
  for (const [hash, choice, timestamp] of [["a".repeat(64), "approve", 1], ["bad", "dots", 1],
    ["A".repeat(64), "dots", 1], ["b".repeat(64), "bots", -1]]) {
    assert.throws(() => db.database.prepare("INSERT INTO team_votes(poll_date,voter_hash,choice,created_at) VALUES (?,?,?,?)")
      .run(DAY, hash, choice, timestamp));
  }
  assert.throws(() => db.database.prepare("INSERT INTO team_votes(poll_date,voter_hash,choice,created_at) VALUES (?,?,?,?)")
    .run("2026-10-11", "a".repeat(64), "bots", 1));
  assert.throws(() => db.database.prepare("UPDATE team_votes SET choice = 'bots'").run());
  assert.throws(() => db.database.prepare("UPDATE team_votes SET poll_date = '2026-10-11'").run());
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO team_polls(poll_date,day) VALUES (?,?)").bind("2026-10-11", 7),
    db.prepare("INSERT INTO team_votes(poll_date,voter_hash,choice,created_at) VALUES (?,?,?,?)").bind("2026-10-11", "bad", "dots", 1),
  ]));
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM team_polls WHERE poll_date = '2026-10-11'").get().n, 0);
  assert.equal((await call()).payload.totalVotes, 1);
  // Direct database maintenance is intentionally privileged; public HTTP never exposes deletes.
  db.database.prepare("DELETE FROM team_votes").run();
  assert.equal((await call()).payload.totalVotes, 0);
});

test("optional provider rate binding checks hashed device/IP, denies before writes and leaves legacy untouched", async t => {
  const { call, db, worker } = setup(t);
  const keys = [];
  const limit = { async limit({ key }) { keys.push(key); return { success: true }; } };
  assert.equal((await call(DAY, { method: "POST", headers: { "CF-Connecting-IP": "192.0.2.1" },
    env: { DB: db, TEAM_VOTE_RATE_LIMITER: limit } })).payload.accepted, true);
  assert.match(keys[0], /^teams:device:[a-f0-9]{64}$/); assert.match(keys[1], /^teams:ip:[a-f0-9]{64}$/);
  assert.ok(keys.every(key => !key.includes(BROWSER) && !key.includes("192.0.2.1")));
  await call(DAY, { env: { DB: db, TEAM_VOTE_RATE_LIMITER: limit } });
  assert.equal(keys.length, 2);
  const approval = await worker.fetch(new Request(`https://voting.example/polls/${encodeURIComponent(APPROVAL)}`, {
    method: "POST", headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ voterId: BROWSER, choice: "approve" }),
  }), { DB: db, TEAM_VOTE_RATE_LIMITER: { limit() { throw new Error("Legacy must not use team binding"); } } });
  assert.equal(approval.status, 200);
  for (const binding of [{ async limit() { return { success: false }; } },
    { async limit({ key }) { return { success: !key.startsWith("teams:ip:") }; } }]) {
    const denied = await call(DAY, { method: "POST", voterId: randomUUID(), headers: { "CF-Connecting-IP": "192.0.2.2" },
      env: { DB: db, TEAM_VOTE_RATE_LIMITER: binding } });
    assert.equal(denied.status, 429); assert.equal(denied.payload.error.code, "rate_limited");
    assert.equal(denied.response.headers.get("Retry-After"), "60");
  }
  for (const binding of [{ async limit() { throw new Error("Unavailable"); } }, { async limit() { return {}; } }]) {
    const failed = await call(DAY, { method: "POST", voterId: randomUUID(), env: { DB: db, TEAM_VOTE_RATE_LIMITER: binding } });
    assert.equal(failed.status, 503); assert.equal(failed.payload.error.code, "rate_limit_unavailable");
  }
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM team_votes").get().n, 1);
});

test("concurrent mixed choices accept each distinct browser exactly once", async t => {
  const { call } = setup(t);
  const same = await Promise.all(Array.from({ length: 25 }, (_, i) => call(DAY,
    { method: "POST", choice: i % 2 ? "dots" : "bots" })));
  assert.ok(same.every(output => output.status === 200));
  assert.equal(same.filter(output => output.payload.accepted).length, 1);
  const firstChoice = same.find(output => output.payload.accepted).payload.yourVote;
  assert.ok(same.every(output => output.payload.yourVote === firstChoice));
  const distinct = await Promise.all(Array.from({ length: 40 }, randomUUID).flatMap((voterId, i) => [
    call(DAY, { method: "POST", voterId, choice: i % 2 ? "dots" : "bots" }),
    call(DAY, { method: "POST", voterId, choice: i % 2 ? "bots" : "dots" }),
  ]));
  assert.equal(distinct.filter(output => output.payload.accepted).length, 40);
  const counts = (await call()).payload;
  assert.equal(counts.totalVotes, 41); assert.equal(counts.dotsVotes + counts.botsVotes, 41);
});

test("independent SQLite transactions retain all increments, original choices and restart history", async t => {
  const directory = await mkdtemp(join(tmpdir(), "codex-28-team-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "teams.sqlite");
  const initial = new TeamSQLiteD1(path); initial.close();
  const sharedVoter = randomUUID();
  const threads = Array.from({ length: 6 }, (_, index) => {
    const votes = Array.from({ length: 20 }, (_, n) => ({ voterId: randomUUID(), choice: (index + n) % 2 ? "dots" : "bots" }));
    votes.splice(2, 0, ...Array.from({ length: 8 }, () => ({ voterId: sharedVoter, choice: index % 2 ? "dots" : "bots" })));
    const thread = new Worker(new URL("./helpers/team-vote-thread.js", import.meta.url), { workerData: { path, data: source, votes } });
    t.after(() => thread.terminate());
    return { thread, ready: new Promise((resolve, reject) => {
      thread.once("message", message => message.ready ? resolve() : reject(new Error("Worker not ready")));
      thread.once("error", reject);
    }), results: new Promise((resolve, reject) => {
      thread.on("message", message => { if (message.results) resolve(message.results); if (message.error) reject(new Error(message.error)); });
      thread.once("error", reject);
    }) };
  });
  await Promise.all(threads.map(thread => thread.ready));
  threads.forEach(thread => thread.thread.postMessage("go"));
  const results = (await Promise.all(threads.map(thread => thread.results))).flat();
  assert.equal(results.length, 168); assert.ok(results.every(output => output.status === 200));
  assert.equal(results.filter(output => output.accepted).length, 121);
  const reopened = new TeamSQLiteD1(path, { migrate: false }); t.after(() => reopened.close());
  const stored = reopened.database.prepare("SELECT * FROM team_polls WHERE poll_date = ?").get(DAY);
  assert.equal(stored.dots_votes + stored.bots_votes, 121);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS n FROM team_votes").get().n, 121);
  assert.ok([60, 61].includes(stored.dots_votes));
  const worker = createVotingWorker({ now: () => new Date("2026-10-10T23:00:00Z"), fetchSource: async () => Response.json(source) });
  const payload = await (await worker.fetch(new Request(`https://voting.example/teams/${DAY}?voterId=${sharedVoter}`), { DB: reopened })).json();
  assert.equal(payload.totalVotes, 121); assert.ok(["dots", "bots"].includes(payload.yourVote));
  const duplicates = results.filter(output => !output.accepted);
  assert.ok(duplicates.every(output => output.yourVote === payload.yourVote));
});
