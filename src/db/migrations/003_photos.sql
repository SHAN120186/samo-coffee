-- Photos instead of the shipped illustrations: cozy coffee photography (see public/img/photos/credits.json).
-- Only values that still hold the original illustration are switched, so an image an admin has already
-- replaced in the panel stays as it is.

UPDATE content_blocks SET value = '/img/photos/hero.jpg'          WHERE page = 'home'          AND key = 'hero_image'   AND value = '/img/hero.svg';
UPDATE content_blocks SET value = '/img/photos/story.jpg'         WHERE page = 'home'          AND key = 'story_image'  AND value = '/img/story.svg';
UPDATE content_blocks SET value = '/img/photos/subscriptions.jpg' WHERE page = 'subscriptions' AND key = 'image'        AND value = '/img/subscription.svg';
UPDATE content_blocks SET value = '/img/photos/about.jpg'         WHERE page = 'about'         AND key = 'image'        AND value = '/img/about.svg';
UPDATE content_blocks SET value = '/img/photos/delivery.jpg'      WHERE page = 'delivery'      AND key = 'image'        AND value = '/img/delivery.svg';
UPDATE content_blocks SET value = '/img/photos/contacts.jpg'      WHERE page = 'contacts'      AND key = 'image'        AND value = '/img/contacts.svg';
UPDATE content_blocks SET value = '/img/photos/tma-banner.jpg'    WHERE page = 'tma'           AND key = 'banner_image' AND value = '/img/tma-banner.svg';

UPDATE categories SET image = '/img/photos/category-espresso.jpg'    WHERE slug = 'espresso'    AND image = '/img/categories/espresso.svg';
UPDATE categories SET image = '/img/photos/category-filter.jpg'      WHERE slug = 'filter'      AND image = '/img/categories/filter.svg';
UPDATE categories SET image = '/img/photos/category-drip.jpg'        WHERE slug = 'drip'        AND image = '/img/categories/drip.svg';
UPDATE categories SET image = '/img/photos/category-accessories.jpg' WHERE slug = 'accessories' AND image = '/img/categories/accessories.svg';

UPDATE plans SET image = '/img/photos/plan-solo.jpg'   WHERE slug = 'solo'   AND image = '/img/plans/plan-1.svg';
UPDATE plans SET image = '/img/photos/plan-duo.jpg'    WHERE slug = 'duo'    AND image = '/img/plans/plan-2.svg';
UPDATE plans SET image = '/img/photos/plan-office.jpg' WHERE slug = 'office' AND image = '/img/plans/plan-3.svg';

UPDATE posts SET cover = '/img/photos/blog-v60.jpg'       WHERE cover = '/img/blog/cover-1.svg';
UPDATE posts SET cover = '/img/photos/blog-ethiopia.jpg'  WHERE cover = '/img/blog/cover-2.svg';
UPDATE posts SET cover = '/img/photos/blog-roaster.jpg'   WHERE cover = '/img/blog/cover-3.svg';
UPDATE posts SET cover = '/img/photos/blog-cold-brew.jpg' WHERE cover = '/img/blog/cover-4.svg';
