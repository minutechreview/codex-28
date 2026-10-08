import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../backend/migrations/0001_daily_polls.sql", import.meta.url), "utf8");

/** Local D1 contract adapter backed by real SQLite, not simulated counters. */
export class SQLiteD1 {
  constructor(path = ":memory:", { migrate = true } = {}) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
    if (migrate) this.database.exec(migration);
  }
  withSession() { return this; }
  prepare(sql) { return new SQLiteStatement(this, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.database.close(); }
}

class SQLiteStatement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new SQLiteStatement(this.db, this.sql, values); }
  execute() {
    const statement = this.db.database.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : [];
    const info = results.length || statement.columns().length ? {} : statement.run(...this.values);
    return { success: true, results: results.map((row) => ({ ...row })), meta: { changes: info.changes ?? 0 } };
  }
  async first() {
    const row = this.db.database.prepare(this.sql).get(...this.values);
    return row ? { ...row } : null;
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
}
