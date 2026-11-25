-- Telegram delivery: resumable broadcasts and demo users.

-- A broadcast walks its recipients in tg_users.id order and stores the last one it has processed,
-- so a send interrupted by a restart continues where it stopped instead of staying "sending" forever.
ALTER TABLE broadcasts ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0;
-- Why a broadcast stopped (status 'failed'): the Telegram error that is the same for every recipient
-- (malformed HTML, bad button URL, wrong token) or "Telegram is unreachable".
ALTER TABLE broadcasts ADD COLUMN error TEXT NOT NULL DEFAULT '';

-- Telegram users created by the demo seed (src/db/seed.js). Their ids are made up, so the bot must
-- never write to them: they are skipped by broadcasts, reminders and order notifications. The flag
-- is cleared as soon as a real person with that id talks to the bot or opens the Mini App.
ALTER TABLE tg_users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
