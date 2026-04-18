-- Rename isKnown to isFeatured on Collection
-- isKnown was a misnaming — the field controls whether a collection
-- appears in the homepage hero slider, not whether it is "verified".
ALTER TABLE "Collection" RENAME COLUMN "isKnown" TO "isFeatured";
