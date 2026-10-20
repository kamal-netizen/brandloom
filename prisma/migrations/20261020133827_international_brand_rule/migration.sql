-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "blockedTerms" TEXT NOT NULL DEFAULT '';

-- Core Champs, Muscle Rulz, Scoops Monster and ProScience are international
-- brands: English only, no UAE / Dubai / AED / Arabic. Only JNK Nutrition (a
-- UAE company) may use them.
UPDATE "Brand"
SET "blockedTerms" = 'uae,dubai,abudhabi,abu dhabi,sharjah,emirates,aed,ksa,saudi,fitnessuae,supplementsuae,dubaifitness,uaefitness,arabic-script'
WHERE "slug" IN ('corechamps', 'musclerulz', 'scoopsmonster', 'proscience');

UPDATE "Brand"
SET "voiceNotes" = "voiceNotes" || ' International brand: captions, hashtags and images in English only. Never mention UAE, Dubai, other Gulf places, AED or Arabic; no #uae / #dubai / #fitnessuae.'
WHERE "slug" IN ('corechamps', 'musclerulz', 'scoopsmonster', 'proscience')
  AND "voiceNotes" NOT LIKE '%International brand:%';

-- Strip UAE/Gulf tags from those brands' hashtag sets (whatever else was edited stays).
UPDATE "HashtagSet" h
SET "tags" = btrim(regexp_replace(
      regexp_replace(h."tags", '(^|\s)#(uae|dubai|abudhabi|sharjah|fitnessuae|supplementsuae|dubaifitness|uaefitness|ksa|saudi)(?=\s|$)', ' ', 'gi'),
      '\s+', ' ', 'g'))
FROM "Brand" b
WHERE b."id" = h."brandId" AND b."slug" IN ('corechamps', 'musclerulz', 'scoopsmonster', 'proscience');
