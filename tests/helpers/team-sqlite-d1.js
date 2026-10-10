import { readFileSync } from "node:fs";
import { SQLiteD1 } from "./sqlite-d1.js";

export const teamMigration = readFileSync(new URL("../../backend/migrations/0002_team_polls.sql", import.meta.url), "utf8");
/** Same real SQLite D1 contract adapter; new migration is opt-in, leaving legacy test setup intact. */
export class TeamSQLiteD1 extends SQLiteD1 {
  constructor(path = ":memory:", { migrate = true } = {}) {
    super(path, { migrate });
    if (migrate) this.database.exec(teamMigration);
  }
}
