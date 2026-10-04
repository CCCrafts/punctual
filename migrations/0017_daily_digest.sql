-- An opt-in morning email listing the day's meetings: the local hour it
-- goes out at (NULL = off), and the local date it last went out on, so a
-- slow or repeated cron tick never sends two.
ALTER TABLE users ADD COLUMN digest_hour INTEGER;
ALTER TABLE users ADD COLUMN digest_sent_on TEXT;
