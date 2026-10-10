import { validateData, dateInTimezone } from "../model.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHOICES = new Set(["dots", "bots"]);
const MAX_VOTE_BYTES = 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const RESULT_SQL = `SELECT p.poll_date, p.dots_votes, p.bots_votes, v.choice AS your_vote
  FROM team_polls AS p LEFT JOIN team_votes AS v ON v.poll_date = p.poll_date AND v.voter_hash = ?
  WHERE p.poll_date = ?`;

class TeamHttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const badInput = (message = "The team vote request is invalid.") => new TeamHttpError(400, "invalid_request", message);

function realDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Bound actual bytes as well as Content-Length, including chunked streams. */
async function boundedText(message, maxBytes, tooLarge) {
  const declaredLength = message.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) throw tooLarge;
  if (!message.body) return "";
  const reader = message.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0; let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw tooLarge; }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function resultPayload(day, open, row) {
  const dotsVotes = row?.dots_votes ?? 0; const botsVotes = row?.bots_votes ?? 0;
  const totalVotes = dotsVotes + botsVotes; const yourVote = row?.your_vote ?? null;
  if (!Number.isSafeInteger(dotsVotes) || dotsVotes < 0 || !Number.isSafeInteger(botsVotes) || botsVotes < 0
      || !Number.isSafeInteger(totalVotes) || (yourVote !== null && !CHOICES.has(yourVote))
      || (yourVote === "dots" && dotsVotes === 0) || (yourVote === "bots" && botsVotes === 0)) {
    throw new Error("Invalid team database result");
  }
  return { day, open, dotsVotes, botsVotes, totalVotes, yourVote };
}

/** Optional provider binding only: never configured by this patch or counted as a global/person guard. */
async function checkRateLimit(request, env, hash) {
  if (!env?.TEAM_VOTE_RATE_LIMITER) return;
  try {
    const device = await env.TEAM_VOTE_RATE_LIMITER.limit({ key: `teams:device:${hash}` });
    if (typeof device?.success !== "boolean") throw new Error("Invalid rate limit result");
    if (!device.success) throw new TeamHttpError(429, "rate_limited", "Please wait before trying another team vote.");
    // Cloudflare sets this header at the edge. Loopback tests inject a harmless fixture IP.
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip && ip.length <= 128) {
      const key = await digest(`codex-28:teams:ip:${ip}`);
      const address = await env.TEAM_VOTE_RATE_LIMITER.limit({ key: `teams:ip:${key}` });
      if (typeof address?.success !== "boolean") throw new Error("Invalid rate limit result");
      if (!address.success) throw new TeamHttpError(429, "rate_limited", "Please wait before trying another team vote.");
    }
  } catch (error) {
    if (error instanceof TeamHttpError) throw error;
    throw new TeamHttpError(503, "rate_limit_unavailable", "Voting is temporarily unavailable. Please try again.");
  }
}

/** Isolated new routes/storage. Its factory receives the existing Worker's fixed production source/origin. */
export function createTeamVotingWorker({ fetchSource = globalThis.fetch, now = () => new Date(), allowedOrigins, sourceUrl }) {
  const origins = new Set(allowedOrigins);
  return {
    async fetch(request, env) {
      const origin = request.headers.get("origin");
      const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Vary": "Origin" });
      if (origin && origins.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
      const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
        status, headers: { ...Object.fromEntries(headers), ...extra },
      });
      try {
        // Capture one server timestamp so source awaits cannot mix dates across Pacific midnight.
        const requestTime = now();
        const currentDate = dateInTimezone(requestTime, "America/Los_Angeles");
        if ((origin && !origins.has(origin)) || (request.method === "POST" && !origin)) {
          throw new TeamHttpError(403, "origin_denied", "This website is not allowed to submit team votes.");
        }
        const url = new URL(request.url);
        const route = /^\/teams\/([^/]+)$/.exec(url.pathname);
        let day;
        try { day = route && decodeURIComponent(route[1]); } catch { throw badInput("The team day is invalid."); }
        if (!realDate(day)) throw new TeamHttpError(404, "team_poll_not_found", "This team poll is not available.");
        if (request.method === "OPTIONS") {
          const requestedHeaders = (request.headers.get("access-control-request-headers") || "").toLowerCase()
            .split(",").map(value => value.trim()).filter(Boolean);
          if (!origin || request.headers.get("access-control-request-method") !== "POST"
              || requestedHeaders.some(header => header !== "content-type")) {
            throw new TeamHttpError(403, "origin_denied", "This preflight request is not allowed.");
          }
          return new Response(null, { status: 204, headers: { ...Object.fromEntries(headers),
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "600" } });
        }
        if (!["GET", "POST"].includes(request.method)) {
          throw new TeamHttpError(405, "method_not_allowed", "Only reading a team poll or submitting a vote is allowed.");
        }
        if ([...url.searchParams.keys()].some(key => key !== "voterId") || url.searchParams.getAll("voterId").length > 1
            || (request.method === "POST" && url.search)) throw badInput();
        let voterId = url.searchParams.get("voterId"); let choice;
        if (request.method === "POST") {
          if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
            throw new TeamHttpError(415, "json_required", "Submit team votes as JSON.");
          }
          let body;
          try { body = JSON.parse(await boundedText(request, MAX_VOTE_BYTES,
            new TeamHttpError(413, "request_too_large", "The team vote request is too large."))); }
          catch (error) { if (error instanceof TeamHttpError) throw error; throw badInput(); }
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2
              || !Object.hasOwn(body, "voterId") || !Object.hasOwn(body, "choice")) throw badInput();
          voterId = body.voterId; choice = body.choice;
          if (!CHOICES.has(choice)) throw badInput("Choose dots or bots.");
        }
        if ((voterId !== null && (typeof voterId !== "string" || !UUID_V4.test(voterId)))
            || (request.method === "POST" && !voterId)) throw badInput("A valid browser voting ID is required.");
        let data;
        try {
          const source = new URL(sourceUrl); source.searchParams.set("teamPollCheck", String(requestTime.getTime()));
          const response = await fetchSource(source.href, { headers: { Accept: "application/json" }, cache: "no-store",
            redirect: "manual", signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error("Source unavailable");
          data = validateData(JSON.parse(await boundedText(response, MAX_SOURCE_BYTES, new Error("Source too large"))));
          if (data.startDate !== "2026-10-05" || data.endDate !== "2026-11-01" || data.timezone !== "America/Los_Angeles") {
            throw new Error("Wrong tracker window");
          }
        } catch { throw new TeamHttpError(503, "updates_unavailable", "The published calendar could not be checked. Please try again."); }
        if (day !== currentDate) throw new TeamHttpError(410, "day_closed", "This Pacific day is closed. Refresh for the current day.");
        const entry = data.days.find(entry => entry.date === day);
        const open = Boolean(entry);
        if (request.method === "POST" && !open) throw new TeamHttpError(410, "day_closed", "The tracker team poll is closed.");
        const hash = voterId === null ? "" : await digest(`codex-28:teams:voter:${voterId.toLowerCase()}`);
        if (request.method === "POST") await checkRateLimit(request, env, hash);
        let payload;
        try {
          if (!env?.DB) throw new Error("Missing database binding");
          const db = typeof env.DB.withSession === "function" ? env.DB.withSession("first-primary") : env.DB;
          if (request.method === "POST") {
            const results = await db.batch([
              db.prepare("INSERT INTO team_polls (poll_date, day) VALUES (?, ?) ON CONFLICT(poll_date) DO NOTHING").bind(day, entry.day),
              db.prepare(`INSERT INTO team_votes (poll_date, voter_hash, choice, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(poll_date, voter_hash) DO NOTHING RETURNING choice`).bind(day, hash, choice, requestTime.getTime()),
              db.prepare(RESULT_SQL).bind(hash, day),
            ]);
            if (results.some(result => result.success === false) || !results[2]?.results?.[0]) throw new Error("Team vote transaction failed");
            payload = { ...resultPayload(day, open, results[2].results[0]), accepted: results[1].results.length === 1 };
          } else { payload = resultPayload(day, open, await db.prepare(RESULT_SQL).bind(hash, day).first()); }
        } catch { throw new TeamHttpError(503, "voting_unavailable", "Team voting is temporarily unavailable. Please try again."); }
        return json(payload);
      } catch (error) {
        if (error instanceof TeamHttpError) return json({ error: { code: error.code, message: error.message } }, error.status,
          error.status === 405 ? { Allow: "GET, POST, OPTIONS" } : error.status === 429 ? { "Retry-After": "60" }
            : error.status === 503 ? { "Retry-After": "5" } : {});
        return json({ error: { code: "voting_unavailable", message: "Team voting is temporarily unavailable. Please try again." } }, 503);
      }
    },
  };
}
