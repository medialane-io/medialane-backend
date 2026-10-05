-- Production already has this default; a replay of the history did not.
ALTER TABLE "Report" ALTER COLUMN "reporterWallet" SET DEFAULT '';
