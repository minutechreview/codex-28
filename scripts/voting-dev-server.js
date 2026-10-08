import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createVotingWorker } from "../backend/worker.js";
import { SQLiteD1 } from "../tests/helpers/sqlite-d1.js";

const port = Number(process.env.VOTING_PORT || process.env.VOTING_DEV_PORT || 8787);
const sourcePath = resolve(process.env.VOTING_DATA_PATH || process.env.VOTING_DEV_SOURCE || "data.json");
const databasePath = resolve(process.env.VOTING_DB_PATH || process.env.VOTING_DEV_DB || ".local-voting.sqlite");
const db = new SQLiteD1(databasePath);
const worker = createVotingWorker({
  allowedOrigins: ["http://127.0.0.1:4173", "http://127.0.0.1:4174", "http://127.0.0.1:4175", "http://127.0.0.1:4176"],
  now: () => process.env.VOTING_DEV_NOW ? new Date(process.env.VOTING_DEV_NOW) : new Date(),
  fetchSource: async () => new Response(await readFile(sourcePath), { headers: { "Content-Type": "application/json" } }),
});
const server = createServer(async (incoming, outgoing) => {
  try {
    const init = { method: incoming.method, headers: incoming.headers };
    if (!["GET", "HEAD"].includes(incoming.method)) { init.body = incoming; init.duplex = "half"; }
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, init);
    const response = await worker.fetch(request, { DB: db });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: { code: "dev_server_error", message: "Local voting server failed." } }));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Local voting API: http://127.0.0.1:${port} (SQLite: ${databasePath})`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
