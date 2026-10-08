import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import productionWorker, { createVotingWorker, SOURCE_URL, SITE_ORIGIN } from "../backend/worker.js";
import { SQLiteD1 } from "./helpers/sqlite-d1.js";

// Keep daily production edits from changing test semantics; only the shared schema/window is reused.
const source = JSON.parse(readFileSync(new URL("../data.json", import.meta.url), "utf8"));
source.days = source.days.map((entry, index) => ({ ...entry, status: index < 3 ? (index === 0 ? "improvement" : "reset") : "pending",
  summary: index < 3 ? `Published fixture for Day ${index + 1}.` : "", tweetUrl: null }));
source.updatedAt = "2026-10-08T15:45:00.000Z";
const DAY_1 = "codex-28:2026-10-05:day-1";
const DAY_2 = "codex-28:2026-10-06:day-2";
const DAY_3 = "codex-28:2026-10-07:day-3";
const DAY_4 = "codex-28:2026-10-08:day-4";
const BROWSER = "0a754e8d-5799-4dca-aa84-54bcaed91d12";

function setup(t, options = {}) {
  const db = new SQLiteD1();
  t.after(() => db.close());
  const context = { data: structuredClone(source), date: new Date("2026-10-08T20:00:00Z"), calls: [] };
  const worker = createVotingWorker({
    now: () => context.date,
    fetchSource: async (url, init) => { context.calls.push({ url, init }); return Response.json(context.data); },
    ...options,
  });
  const call = async (pollId = DAY_1, { method = "GET", voterId = BROWSER, choice = "approve", body,
    headers, origin = SITE_ORIGIN, query, rawPath, env = { DB: db } } = {}) => {
    const url = `https://voting.example${rawPath ?? `/polls/${encodeURIComponent(pollId)}`}${query ??
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

test("public counts begin at zero, then persist a browser vote and original choice", async (t) => {
  const { call, db } = setup(t);
  assert.deepEqual((await call(DAY_1, { voterId: null, origin: null })).payload,
    { pollId: DAY_1, approve: 0, notConvinced: 0, total: 0, yourVote: null });
  const first = await call(DAY_1, { method: "POST" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.payload, { pollId: DAY_1, approve: 1, notConvinced: 0, total: 1, yourVote: "approve", accepted: true });
  const repeat = await call(DAY_1, { method: "POST", choice: "not_convinced" });
  assert.equal(repeat.payload.accepted, false);
  assert.equal(repeat.payload.yourVote, "approve");
  assert.equal(repeat.payload.total, 1);
  assert.equal((await call()).payload.yourVote, "approve");
  assert.equal((await call(DAY_1, { voterId: randomUUID() })).payload.yourVote, null);
  const stored = db.database.prepare("SELECT * FROM votes").get();
  assert.match(stored.voter_hash, /^[a-f0-9]{64}$/);
  assert.equal(Object.values(stored).includes(BROWSER), false);
});

test("browser ID case normalization cannot create duplicate votes", async (t) => {
  const { call } = setup(t);
  await call(DAY_1, { method: "POST" });
  assert.equal((await call(DAY_1, { method: "POST", voterId: BROWSER.toUpperCase() })).payload.accepted, false);
  assert.equal((await call(DAY_1, { voterId: BROWSER.toUpperCase() })).payload.yourVote, "approve");
});

test("same-day edits and advancing the day retain independently stored history", async (t) => {
  const { call, context } = setup(t);
  await call(DAY_1, { method: "POST" });
  await call(DAY_2, { method: "POST", choice: "not_convinced" });
  context.data.days[0].summary = "Corrected explanation of the same update.";
  context.data.days[0].status = "reset";
  context.data.updatedAt = "2026-10-09T18:00:00.000Z";
  context.date = new Date("2026-10-09T20:00:00Z");
  context.data.days[3] = { ...context.data.days[3], status: "missed", summary: "No improvement reported today." };
  await call(DAY_4, { method: "POST", choice: "not_convinced" });
  assert.equal((await call(DAY_1)).payload.approve, 1);
  assert.equal((await call(DAY_2)).payload.notConvinced, 1);
  assert.equal((await call(DAY_3)).payload.total, 0);
  assert.equal((await call(DAY_4)).payload.notConvinced, 1);
  context.data.days[0].status = "pending";
  assert.equal((await call(DAY_1)).status, 404);
  context.data.days[0].status = "improvement";
  assert.equal((await call(DAY_1)).payload.approve, 1);
});

test("pending, future, mismatched, missing, and malformed poll IDs fail closed", async (t) => {
  const { call, context, db } = setup(t);
  for (const pollId of [DAY_4, "codex-28:2026-10-04:day-1", "codex-28:2026-10-05:day-2",
    "codex-28:2026-10-05:day-01", "codex-28:2026-10-05:day-29", "codex-28:2026-13-05:day-1",
    "codex-28:2026-10-05:day-1' OR 1=1", "day-1"]) {
    assert.equal((await call(pollId, { method: "POST" })).status, 404, pollId);
  }
  assert.equal((await call(DAY_1, { rawPath: "/polls/%E0%A4%A" })).status, 400);
  context.data.days[4] = { ...context.data.days[4], status: "improvement", summary: "Published too early." };
  assert.equal((await call("codex-28:2026-10-09:day-5", { method: "POST" })).status, 404);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM votes").get().n, 0);
});

test("opening is based on Pacific calendar date including final DST day", async (t) => {
  const { call, context } = setup(t);
  context.data.days[3] = { ...context.data.days[3], status: "improvement", summary: "Day 4 posted." };
  context.date = new Date("2026-10-08T06:59:59Z");
  assert.equal((await call(DAY_4)).status, 404);
  context.date = new Date("2026-10-08T07:00:00Z");
  assert.equal((await call(DAY_4)).status, 200);
  context.data.days[27] = { ...context.data.days[27], status: "reset", summary: "Final reset." };
  const lastDay = "codex-28:2026-11-01:day-28";
  context.date = new Date("2026-11-01T06:59:59Z");
  assert.equal((await call(lastDay)).status, 404);
  context.date = new Date("2026-11-01T07:00:00Z");
  assert.equal((await call(lastDay, { method: "POST" })).status, 200);
  context.date = new Date("2026-11-02T08:00:00Z");
  assert.equal((await call(lastDay)).payload.total, 1);
});

test("strict JSON, UUIDv4, choice and query validation rejects visitor update writes", async (t) => {
  const { call, db } = setup(t);
  const badBodies = ["{", "null", "[]", JSON.stringify({ voterId: BROWSER }),
    JSON.stringify({ voterId: BROWSER, choice: "approve", summary: "Changed by a visitor" }),
    JSON.stringify({ voterId: BROWSER, choice: "reset" }),
    JSON.stringify({ voterId: BROWSER, choice: null }),
    JSON.stringify({ voterId: "0a754e8d-5799-1dca-aa84-54bcaed91d12", choice: "approve" }),
    JSON.stringify({ voterId: "0a754e8d-5799-4dca-0a84-54bcaed91d12", choice: "approve" }),
    JSON.stringify({ voterId: 123, choice: "approve" }),
    JSON.stringify({ voterId: null, choice: "approve" })];
  for (const body of badBodies) assert.equal((await call(DAY_1, { method: "POST", body })).status, 400, body);
  assert.equal((await call(DAY_1, { voterId: "invalid" })).status, 400);
  assert.equal((await call(DAY_1, { voterId: "" })).status, 400);
  assert.equal((await call(DAY_1, { query: `?voterId=${BROWSER}&voterId=${BROWSER}` })).status, 400);
  assert.equal((await call(DAY_1, { query: "?summary=malicious" })).status, 400);
  assert.equal((await call(DAY_1, { method: "POST", query: `?voterId=${BROWSER}` })).status, 400);
  assert.equal((await call(DAY_1, { method: "POST", headers: { "Content-Type": "text/plain" } })).status, 415);
  for (const method of ["PUT", "PATCH", "DELETE"]) assert.equal((await call(DAY_1, { method })).status, 405);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM votes").get().n, 0);
});

test("request stream and declared size are bounded independently", async (t) => {
  const { call, worker, db } = setup(t);
  assert.equal((await call(DAY_1, { method: "POST", body: "x".repeat(1025) })).status, 413);
  assert.equal((await call(DAY_1, { method: "POST", headers: { "Content-Length": "10000" } })).status, 413);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(600)); controller.enqueue(new Uint8Array(600)); controller.close();
  } });
  const response = await worker.fetch(new Request(`https://voting.example/polls/${encodeURIComponent(DAY_1)}`, {
    method: "POST", body: stream, duplex: "half", headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" },
  }), { DB: db });
  assert.equal(response.status, 413);
});

test("CORS allows only the website origin and never allows credentials", async (t) => {
  const { call, context } = setup(t);
  for (const origin of ["https://evil.example", "https://minutechreview.github.io.evil.example", "http://minutechreview.github.io", "null"]) {
    const output = await call(DAY_1, { method: "POST", origin });
    assert.equal(output.status, 403);
    assert.equal(output.response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await call(DAY_1, { method: "POST", origin: null })).status, 403);
  assert.equal(context.calls.length, 0);
  const preflight = await call(DAY_1, { method: "OPTIONS", headers: {
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type",
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.response.headers.get("access-control-allow-origin"), SITE_ORIGIN);
  assert.equal(preflight.response.headers.get("access-control-allow-credentials"), null);
  assert.equal((await call(DAY_1, { method: "OPTIONS", headers: {
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization",
  } })).status, 403);
  assert.equal((await call(DAY_1, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE" } })).status, 403);
  const get = await call();
  assert.equal(get.response.headers.get("cache-control"), "no-store");
  assert.equal(get.response.headers.get("vary"), "Origin");
});

test("published source is fixed, fetched without caching, and invalid data is never writable", async (t) => {
  const { call, context } = setup(t);
  await call();
  await call(DAY_1, { method: "POST" });
  assert.equal(context.calls.length, 2);
  for (const { url, init } of context.calls) {
    assert.equal(url.split("?")[0], SOURCE_URL);
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.cf.cacheTtl, 0);
    assert.ok(init.signal instanceof AbortSignal);
  }
  context.data = { days: [{ day: 1, status: "improvement" }] };
  const invalid = await call(DAY_1, { method: "POST", voterId: randomUUID() });
  assert.equal(invalid.status, 503);
  assert.equal(invalid.payload.error.code, "updates_unavailable");
});

test("source network, oversized, JSON and HTTP failures keep counts unchanged", async (t) => {
  for (const fetchSource of [async () => { throw new Error("Network"); }, async () => new Response("bad json"),
    async () => new Response("unavailable", { status: 503 }), async () => new Response(" ".repeat(65537))]) {
    const { call, db } = setup(t, { fetchSource });
    const output = await call(DAY_1, { method: "POST" });
    assert.equal(output.status, 503);
    assert.equal(output.payload.error.code, "updates_unavailable");
    assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM votes").get().n, 0);
  }
});

test("database failures report retryable states without inventing success", async (t) => {
  const { call } = setup(t);
  const failingDB = { prepare() { throw new Error("Database offline"); } };
  for (const method of ["GET", "POST"]) {
    const output = await call(DAY_1, { method, env: { DB: failingDB } });
    assert.equal(output.status, 503);
    assert.equal(output.payload.error.code, "voting_unavailable");
    assert.equal(output.response.headers.get("Retry-After"), "5");
    assert.equal(output.payload.accepted, undefined);
  }
  assert.equal((await call(DAY_1, { method: "POST", env: {} })).status, 503);
});

test("database CHECK, immutable vote and rollback constraints enforce invariants", async (t) => {
  const { call, db } = setup(t);
  await call(DAY_1, { method: "POST" });
  assert.throws(() => db.database.prepare("INSERT INTO polls(poll_id,poll_date,day) VALUES (?,?,?)")
    .run("codex-28:2026-10-05:day-2", "2026-10-05", 2));
  for (const date of ["2026-10-xx", "2026-10-32", "2026-10-05junk"]) {
    assert.throws(() => db.database.prepare("INSERT INTO polls(poll_id,poll_date,day) VALUES (?,?,?)")
      .run(`codex-28:${date}:day-1`, date, 1));
  }
  assert.throws(() => db.database.prepare("INSERT INTO votes(poll_id,voter_hash,choice,created_at) VALUES (?,?,?,?)")
    .run(DAY_1, "a".repeat(64), "reset", 1));
  assert.throws(() => db.database.prepare("INSERT INTO votes(poll_id,voter_hash,choice,created_at) VALUES (?,?,?,?)")
    .run(DAY_2, "a".repeat(64), "approve", 1));
  assert.throws(() => db.database.prepare("UPDATE votes SET choice = 'not_convinced'").run());
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO polls(poll_id,poll_date,day) VALUES (?,?,?)").bind(DAY_2, "2026-10-06", 2),
    db.prepare("INSERT INTO votes(poll_id,voter_hash,choice,created_at) VALUES (?,?,?,?)").bind(DAY_2, "bad", "approve", 1),
  ]));
  assert.equal(db.database.prepare("SELECT COUNT(*) AS n FROM polls WHERE poll_id = ?").get(DAY_2).n, 0);
  assert.equal((await call()).payload.total, 1);
});

test("concurrent HTTP submissions on one worker count distinct browsers exactly once", async (t) => {
  const { call } = setup(t);
  const sameBrowser = await Promise.all(Array.from({ length: 25 }, (_, i) => call(DAY_1,
    { method: "POST", choice: i % 2 ? "approve" : "not_convinced" })));
  assert.equal(sameBrowser.filter((result) => result.payload.accepted).length, 1);
  assert.ok(sameBrowser.every((result) => result.status === 200));
  const voters = Array.from({ length: 40 }, () => randomUUID());
  const distinct = await Promise.all(voters.flatMap((voterId, i) => [
    call(DAY_1, { method: "POST", voterId, choice: i % 2 ? "approve" : "not_convinced" }),
    call(DAY_1, { method: "POST", voterId, choice: i % 2 ? "not_convinced" : "approve" }),
  ]));
  assert.equal(distinct.filter((result) => result.payload.accepted).length, 40);
  const counts = (await call()).payload;
  assert.equal(counts.total, 41);
  assert.equal(counts.approve + counts.notConvinced, 41);
});

test("independent concurrent SQLite connections have no lost increments; restart retains history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-28-vote-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "votes.sqlite");
  const initial = new SQLiteD1(path);
  initial.close();
  const sharedVoter = randomUUID();
  const workers = Array.from({ length: 6 }, (_, index) => {
    const votes = Array.from({ length: 20 }, (_, n) => ({ pollId: DAY_1, voterId: randomUUID(),
      choice: (index + n) % 2 ? "approve" : "not_convinced" }));
    votes.splice(2, 0, ...Array.from({ length: 8 }, () => ({ pollId: DAY_1, voterId: sharedVoter,
      choice: index % 2 ? "approve" : "not_convinced" })));
    const thread = new Worker(new URL("./helpers/vote-thread.js", import.meta.url), { workerData: { path, data: source, votes } });
    t.after(() => thread.terminate());
    return { thread, ready: new Promise((resolve, reject) => {
      thread.once("message", (message) => message.ready ? resolve() : reject(new Error("Worker not ready")));
      thread.once("error", reject);
    }), results: new Promise((resolve, reject) => {
      thread.on("message", (message) => {
        if (message.results) resolve(message.results);
        if (message.error) reject(new Error(message.error));
      });
      thread.once("error", reject);
    }) };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  workers.forEach((worker) => worker.thread.postMessage("go"));
  const results = (await Promise.all(workers.map((worker) => worker.results))).flat();
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(results.filter((result) => result.accepted).length, 121);
  const reopened = new SQLiteD1(path, { migrate: false });
  t.after(() => reopened.close());
  const stored = reopened.database.prepare("SELECT * FROM polls WHERE poll_id = ?").get(DAY_1);
  assert.equal(stored.approve + stored.not_convinced, 121);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS n FROM votes").get().n, 121);
  assert.ok([60, 61].includes(stored.approve));
  const worker = createVotingWorker({ now: () => new Date("2026-10-09T20:00:00Z"), fetchSource: async () => Response.json(source) });
  const response = await worker.fetch(new Request(`https://voting.example/polls/${encodeURIComponent(DAY_1)}?voterId=${sharedVoter}`), { DB: reopened });
  const payload = await response.json();
  assert.equal(payload.total, 121);
  assert.ok(["approve", "not_convinced"].includes(payload.yourVote));
});

test("production default has no public update/admin routes or configurable source bindings", async () => {
  for (const path of ["/admin", "/updates", "/data.json", "/", "/polls"]) {
    const response = await productionWorker.fetch(new Request(`https://voting.example${path}`), {
      SOURCE_URL: "https://evil.example", ALLOWED_ORIGIN: "https://evil.example",
    });
    assert.equal(response.status, 404);
  }
});
