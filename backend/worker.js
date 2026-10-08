import { validateData, dateInTimezone } from "../model.js";

export const SOURCE_URL = "https://minutechreview.github.io/codex-28/data.json";
export const SITE_ORIGIN = "https://minutechreview.github.io";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLL_ID = /^codex-28:(\d{4}-\d{2}-\d{2}):day-([1-9]|1\d|2[0-8])$/;
const CHOICES = new Set(["approve", "not_convinced"]);
const MAX_VOTE_BYTES = 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const RESULT_SQL = `SELECT p.poll_id, p.approve, p.not_convinced, v.choice AS your_vote
  FROM polls AS p LEFT JOIN votes AS v ON v.poll_id = p.poll_id AND v.voter_hash = ?
  WHERE p.poll_id = ?`;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function badInput(message = "The vote request is invalid.") {
  return new HttpError(400, "invalid_request", message);
}

/** Bound the actual stream, including chunked requests without Content-Length. */
async function boundedText(message, maxBytes, tooLarge) {
  const declaredLength = message.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw tooLarge;
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw tooLarge;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function voterHash(voterId) {
  const bytes = new TextEncoder().encode(`codex-28:voter:${voterId.toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resultPayload(pollId, row) {
  const approve = row?.approve ?? 0;
  const notConvinced = row?.not_convinced ?? 0;
  if (!Number.isSafeInteger(approve) || approve < 0 || !Number.isSafeInteger(notConvinced) || notConvinced < 0 ||
      !Number.isSafeInteger(approve + notConvinced) || (row?.your_vote != null && !CHOICES.has(row.your_vote))) {
    throw new Error("Invalid database result");
  }
  return { pollId, approve, notConvinced, total: approve + notConvinced, yourVote: row?.your_vote ?? null };
}

/** Injection is for local tests/dev only. The default production export is fixed. */
export function createVotingWorker({ fetchSource = globalThis.fetch, now = () => new Date(),
  allowedOrigins = [SITE_ORIGIN], sourceUrl = SOURCE_URL } = {}) {
  const origins = new Set(allowedOrigins);
  return {
    async fetch(request, env) {
      const origin = request.headers.get("origin");
      const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Vary": "Origin",
      });
      if (origin && origins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
      const json = (body, status = 200, extraHeaders = {}) => {
        const outputHeaders = new Headers(headers);
        for (const [key, value] of Object.entries(extraHeaders)) outputHeaders.set(key, value);
        return new Response(JSON.stringify(body), { status, headers: outputHeaders });
      };
      try {
        if ((origin && !origins.has(origin)) || (request.method === "POST" && !origin)) {
          throw new HttpError(403, "origin_denied", "This website is not allowed to submit votes.");
        }
        const url = new URL(request.url);
        const route = /^\/polls\/([^/]+)$/.exec(url.pathname);
        let pollId;
        try { pollId = route && decodeURIComponent(route[1]); } catch { throw badInput("The poll ID is invalid."); }
        const match = typeof pollId === "string" && POLL_ID.exec(pollId);
        if (!match) throw new HttpError(404, "poll_not_found", "This poll is not available.");
        if (request.method === "OPTIONS") {
          if (!origin || request.headers.get("access-control-request-method") !== "POST") {
            throw new HttpError(403, "origin_denied", "This preflight request is not allowed.");
          }
          const requestedHeaders = (request.headers.get("access-control-request-headers") || "")
            .toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
          if (requestedHeaders.some((header) => header !== "content-type")) {
            throw new HttpError(403, "origin_denied", "This preflight request is not allowed.");
          }
          return new Response(null, { status: 204, headers: {
            ...Object.fromEntries(headers), "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600",
          } });
        }
        if (!["GET", "POST"].includes(request.method)) {
          throw new HttpError(405, "method_not_allowed", "Only reading a poll or submitting a vote is allowed.");
        }
        if ([...url.searchParams.keys()].some((key) => key !== "voterId") || url.searchParams.getAll("voterId").length > 1 ||
            (request.method === "POST" && url.search)) throw badInput();
        let voterId = url.searchParams.get("voterId");
        let choice;
        if (request.method === "POST") {
          if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
            throw new HttpError(415, "json_required", "Submit votes as JSON.");
          }
          let body;
          try {
            const text = await boundedText(request, MAX_VOTE_BYTES,
              new HttpError(413, "request_too_large", "The vote request is too large."));
            body = JSON.parse(text);
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw badInput();
          }
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
              !Object.hasOwn(body, "voterId") || !Object.hasOwn(body, "choice")) throw badInput();
          voterId = body.voterId;
          choice = body.choice;
          if (!CHOICES.has(choice)) throw badInput("Choose approve or not_convinced.");
        }
        if ((voterId !== null && (typeof voterId !== "string" || !UUID_V4.test(voterId))) ||
            (request.method === "POST" && !voterId)) throw badInput("A valid browser voting ID is required.");

        // Every read and write checks the actual published JSON. Never trust a client poll list.
        let data;
        try {
          const source = new URL(sourceUrl);
          source.searchParams.set("pollCheck", String(now().getTime()));
          const response = await fetchSource(source.href, {
            // Workers supports manual/follow only; non-2xx (including redirects) fails closed below.
            headers: { Accept: "application/json" }, cache: "no-store", redirect: "manual",
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error("Source unavailable");
          data = validateData(JSON.parse(await boundedText(response, MAX_SOURCE_BYTES, new Error("Source too large"))));
          if (data.startDate !== "2026-10-05" || data.endDate !== "2026-11-01" || data.timezone !== "America/Los_Angeles") {
            throw new Error("Wrong tracker window");
          }
        } catch {
          throw new HttpError(503, "updates_unavailable", "The published updates could not be checked. Please try again.");
        }
        const entry = data.days[Number(match[2]) - 1];
        if (!entry || entry.date !== match[1] || entry.status === "pending" ||
            entry.date > dateInTimezone(now(), "America/Los_Angeles")) {
          throw new HttpError(404, "poll_not_found", "Voting opens when this day's update is published.");
        }
        const hash = voterId === null ? "" : await voterHash(voterId);
        let payload;
        try {
          if (!env?.DB) throw new Error("Missing database binding");
          // Primary reads avoid stale counts if D1 read replication is later enabled.
          const db = typeof env.DB.withSession === "function" ? env.DB.withSession("first-primary") : env.DB;
          if (request.method === "POST") {
            const results = await db.batch([
              db.prepare("INSERT INTO polls (poll_id, poll_date, day) VALUES (?, ?, ?) ON CONFLICT(poll_id) DO NOTHING")
                .bind(pollId, entry.date, entry.day),
              db.prepare(`INSERT INTO votes (poll_id, voter_hash, choice, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(poll_id, voter_hash) DO NOTHING RETURNING choice`)
                .bind(pollId, hash, choice, now().getTime()),
              db.prepare(RESULT_SQL).bind(hash, pollId),
            ]);
            if (results.some((result) => result.success === false) || !results[2]?.results?.[0]) {
              throw new Error("Vote transaction failed");
            }
            payload = { ...resultPayload(pollId, results[2].results[0]), accepted: results[1].results.length === 1 };
          } else {
            const row = await db.prepare(RESULT_SQL).bind(hash, pollId).first();
            payload = resultPayload(pollId, row);
          }
        } catch {
          throw new HttpError(503, "voting_unavailable", "Voting is temporarily unavailable. Please try again.");
        }
        return json(payload);
      } catch (error) {
        if (error instanceof HttpError) {
          return json({ error: { code: error.code, message: error.message } }, error.status,
            error.status === 405 ? { Allow: "GET, POST, OPTIONS" } : error.status === 503 ? { "Retry-After": "5" } : {});
        }
        return json({ error: { code: "voting_unavailable", message: "Voting is temporarily unavailable. Please try again." } }, 503);
      }
    },
  };
}

export default createVotingWorker();
