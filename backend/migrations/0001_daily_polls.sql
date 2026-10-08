-- Append-only visitor votes; counters update in the same SQLite transaction.
CREATE TABLE IF NOT EXISTS polls (
  poll_id TEXT PRIMARY KEY,
  poll_date TEXT NOT NULL CHECK (poll_date BETWEEN '2026-10-05' AND '2026-11-01'),
  day INTEGER NOT NULL CHECK (typeof(day) = 'integer' AND day BETWEEN 1 AND 28),
  approve INTEGER NOT NULL DEFAULT 0 CHECK (typeof(approve) = 'integer' AND approve >= 0),
  not_convinced INTEGER NOT NULL DEFAULT 0 CHECK (typeof(not_convinced) = 'integer' AND not_convinced >= 0),
  CHECK (poll_id = 'codex-28:' || poll_date || ':day-' || day),
  CHECK (poll_date = date('2026-10-05', '+' || (day - 1) || ' days'))
);

CREATE TABLE IF NOT EXISTS votes (
  poll_id TEXT NOT NULL REFERENCES polls(poll_id),
  voter_hash TEXT NOT NULL CHECK (length(voter_hash) = 64 AND voter_hash NOT GLOB '*[^0-9a-f]*'),
  choice TEXT NOT NULL CHECK (choice IN ('approve', 'not_convinced')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  PRIMARY KEY (poll_id, voter_hash)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS votes_count_insert AFTER INSERT ON votes
BEGIN
  UPDATE polls SET approve = approve + (NEW.choice = 'approve'),
    not_convinced = not_convinced + (NEW.choice = 'not_convinced')
  WHERE poll_id = NEW.poll_id;
END;

CREATE TRIGGER IF NOT EXISTS votes_immutable BEFORE UPDATE ON votes
BEGIN
  SELECT RAISE(ABORT, 'Recorded votes cannot be changed');
END;

-- An authorized database maintainer may remove abusive votes without drifting counts.
CREATE TRIGGER IF NOT EXISTS votes_count_delete AFTER DELETE ON votes
BEGIN
  UPDATE polls SET approve = approve - (OLD.choice = 'approve'),
    not_convinced = not_convinced - (OLD.choice = 'not_convinced')
  WHERE poll_id = OLD.poll_id;
END;
