-- Data patch: all UNKNOWN collections are ERC721; fix so intent API stops sending UNKNOWN to frontend
UPDATE "Collection" SET standard = 'ERC721' WHERE standard = 'UNKNOWN';
