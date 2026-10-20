-- The five brands Brandloom manages, with a starter hashtag set each.
-- ON CONFLICT DO NOTHING: anything edited in the UI is never overwritten.

INSERT INTO "Brand" ("id","slug","name","website","primaryColor","secondaryColor","accentColor","voiceNotes","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'corechamps', 'Core Champs', 'corechamps.com', '#0a0a0a', '#d9dde3', '#ffffff', 'Premium, dark/chrome, confident. Tagline: BECOME A CHAMP. Kai Greene is the face of the brand.', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "HashtagSet" ("id","brandId","name","tags","isDefault","createdAt","updatedAt")
SELECT gen_random_uuid()::text, "id", 'default', '#corechamps #becomeachamp #wheyprotein #supplements #fitness #gym #bodybuilding #uae #dubai', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Brand" WHERE "slug" = 'corechamps'
ON CONFLICT ("brandId","name") DO NOTHING;

INSERT INTO "Brand" ("id","slug","name","website","primaryColor","secondaryColor","accentColor","voiceNotes","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'jnk', 'JNK Nutrition', 'jnknutrition.com', '#082D4C', '#FFCE00', '#ffffff', 'UAE official distributor of genuine sports supplements. Friendly, helpful. Footer: logo + website only.', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "HashtagSet" ("id","brandId","name","tags","isDefault","createdAt","updatedAt")
SELECT gen_random_uuid()::text, "id", 'default', '#jnknutrition #supplementsuae #dubai #abudhabi #uae #fitnessuae #wheyprotein #preworkout #gymlife', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Brand" WHERE "slug" = 'jnk'
ON CONFLICT ("brandId","name") DO NOTHING;

INSERT INTO "Brand" ("id","slug","name","website","primaryColor","secondaryColor","accentColor","voiceNotes","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'musclerulz', 'Muscle Rulz', 'musclerulz.com', '#000000', '#35C0FF', '#ffffff', 'Aggressive, athletic. Tagline: TRAIN. FIGHT. WIN.', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "HashtagSet" ("id","brandId","name","tags","isDefault","createdAt","updatedAt")
SELECT gen_random_uuid()::text, "id", 'default', '#musclerulz #trainfightwin #wheyrulz #supplements #fitness #gym #bodybuilding #uae', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Brand" WHERE "slug" = 'musclerulz'
ON CONFLICT ("brandId","name") DO NOTHING;

INSERT INTO "Brand" ("id","slug","name","website","primaryColor","secondaryColor","accentColor","voiceNotes","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'scoopsmonster', 'Scoops Monster', 'scoopsmonster.com', '#10131A', '#E00007', '#ffffff', 'Bold, fun, monster energy. Tagline: Unleash The Monster Within.', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "HashtagSet" ("id","brandId","name","tags","isDefault","createdAt","updatedAt")
SELECT gen_random_uuid()::text, "id", 'default', '#scoopsmonster #unleashthemonster #bcaa #wheyprotein #supplements #fitness #gym', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Brand" WHERE "slug" = 'scoopsmonster'
ON CONFLICT ("brandId","name") DO NOTHING;

INSERT INTO "Brand" ("id","slug","name","website","primaryColor","secondaryColor","accentColor","voiceNotes","sortOrder","createdAt","updatedAt")
VALUES (gen_random_uuid()::text, 'proscience', 'ProScience Nutra', NULL, '#231F20', '#ED1C24', '#00AEEF', 'Science-backed performance. Lines used before: BUILD MASS. / FEEL THE PUMP.', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
INSERT INTO "HashtagSet" ("id","brandId","name","tags","isDefault","createdAt","updatedAt")
SELECT gen_random_uuid()::text, "id", 'default', '#proscience #prosciencenutra #massgainer #wheyprotein #supplements #fitness #gym #uae', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "Brand" WHERE "slug" = 'proscience'
ON CONFLICT ("brandId","name") DO NOTHING;
