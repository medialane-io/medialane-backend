UPDATE "Identity"
SET value = lower(value)
WHERE scheme = 'email' AND value IS NOT NULL AND value <> lower(value);
