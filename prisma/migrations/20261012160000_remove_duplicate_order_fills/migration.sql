DELETE FROM "OrderFill" f
USING "OrderFill" keep
WHERE f."chain" = keep."chain"
  AND f."orderHash" = keep."orderHash"
  AND f."txHash" = keep."txHash"
  AND f."quantity" = keep."quantity"
  AND f."remainingAmount" IS NOT DISTINCT FROM keep."remainingAmount"
  AND f."logIndex" < keep."logIndex";
