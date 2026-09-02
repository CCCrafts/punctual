-- Team roles start meaning something, and schedules record who set them up.
--
-- Additive, forward-only (ADR-0006 §4).

-- Who created / last changed a schedule. NULL = the owner themselves, or a
-- row from before this column existed; a different user id means a team
-- admin set it up on the owner's behalf.
ALTER TABLE schedules ADD COLUMN created_by TEXT;
ALTER TABLE schedules ADD COLUMN updated_by TEXT;

-- Every team gets at least one admin. The dashboard has always written the
-- creator as 'admin', but a team assembled through the repository directly
-- (TeamRepository.create + addMember) could end up all-'member' — and from
-- this migration on, an all-member team is one nobody but an instance admin
-- can manage. Promote the earliest-inserted member (rowid order is insertion
-- order for a rowid table) of each such team.
UPDATE team_members SET role = 'admin'
WHERE rowid IN (
  SELECT MIN(rowid) FROM team_members AS tm
  WHERE NOT EXISTS (
    SELECT 1 FROM team_members AS m
    WHERE m.team_id = tm.team_id AND m.role IN ('owner', 'admin')
  )
  GROUP BY tm.team_id
);
