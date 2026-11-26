-- Demo bot users loaded before the seed set tg_users.is_demo (SEED_ON_EMPTY stands deployed earlier).
-- The seed runs before the first administrator is created and back-dates its users, so every Telegram
-- user older than the first admin account came from the seed: no real person could have used the bot
-- before the shop existed. Real users are created later and keep is_demo = 0.
UPDATE tg_users SET is_demo = 1
 WHERE is_demo = 0
   AND created_at < (SELECT MIN(created_at) FROM admins);
