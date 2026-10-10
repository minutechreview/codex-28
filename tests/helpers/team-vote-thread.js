import { parentPort, workerData } from "node:worker_threads";
import { createVotingWorker, SITE_ORIGIN } from "../../backend/worker.js";
import { TeamSQLiteD1 } from "./team-sqlite-d1.js";

const db = new TeamSQLiteD1(workerData.path, { migrate: false });
const worker = createVotingWorker({ now: () => new Date("2026-10-10T20:00:00Z"),
  fetchSource: async () => Response.json(workerData.data) });
parentPort.postMessage({ ready: true });
parentPort.once("message", async () => {
  try {
    const results = [];
    for (const vote of workerData.votes) {
      const response = await worker.fetch(new Request(`https://voting.example/teams/2026-10-10`, {
        method: "POST", headers: { Origin: SITE_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(vote),
      }), { DB: db });
      results.push({ status: response.status, ...await response.json() });
    }
    db.close(); parentPort.postMessage({ results });
  } catch (error) { db.close(); parentPort.postMessage({ error: error.message }); }
});
