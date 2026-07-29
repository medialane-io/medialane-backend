-- Drop the creator-profile banner image column. Redundant with AccountProfile.avatarImage,
-- which now covers both the creator's avatar and platform theming. CollectionProfile.bannerImage
-- is a separate, unaffected feature (collection cover image).
ALTER TABLE "AccountProfile" DROP COLUMN "bannerImage";
