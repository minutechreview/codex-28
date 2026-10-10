-- Additive team-poll storage. Existing approval polls/votes and their triggers remain untouched.
CREATE TABLE IF NOT EXISTS team_polls (
  poll_date TEXT PRIMARY KEY NOT NULL CHECK (poll_date BETWEEN '2026-10-05' AND '2026-11-01'),
  day INTEGER NOT NULL CHECK (typeof(day) = 'integer' AND day BETWEEN 1 AND 28),
  dots_votes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(dots_votes) = 'integer' AND dots_votes >= 0),
  bots_votes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(bots_votes) = 'integer' AND bots_votes >= 0),
  CHECK (poll_date = date('2026-10-05', '+' || (day - 1) || ' days'))
);
CREATE TABLE IF NOT EXISTS team_votes (
  poll_date TEXT NOT NULL REFERENCES team_polls(poll_date),
  voter_hash TEXT NOT NULL CHECK (length(voter_hash) = 64 AND voter_hash NOT GLOB '*[^0-9a-f]*'),
  choice TEXT NOT NULL CHECK (choice IN ('dots', 'bots')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  PRIMARY KEY (poll_date, voter_hash)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS team_votes_count_insert AFTER INSERT ON team_votes
BEGIN
  UPDATE team_polls SET dots_votes = dots_votes + (NEW.choice = 'dots'),
    bots_votes = bots_votes + (NEW.choice = 'bots') WHERE poll_date = NEW.poll_date;
END;
CREATE TRIGGER IF NOT EXISTS team_votes_immutable BEFORE UPDATE ON team_votes
BEGIN
  SELECT RAISE(ABORT, 'Recorded team votes cannot be changed');
END;
-- Authorized database maintenance can remove an abusive row without drifting counters.
CREATE TRIGGER IF NOT EXISTS team_votes_count_delete AFTER DELETE ON team_votes
BEGIN
  UPDATE team_polls SET dots_votes = dots_votes - (OLD.choice = 'dots'),
    bots_votes = bots_votes - (OLD.choice = 'bots') WHERE poll_date = OLD.poll_date;
END;
