-- A team's name is shown to guests as a modest suffix after the hosts'
-- names, and a team may switch it off. Team logos are no longer shown;
-- the columns stay so nothing is lost on a downgrade.
ALTER TABLE teams ADD COLUMN show_name INTEGER NOT NULL DEFAULT 1;
