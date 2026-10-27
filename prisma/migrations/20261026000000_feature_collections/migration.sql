UPDATE "Collection"
SET "isFeatured" = true
WHERE "chain" = 'STARKNET'
  AND "contractAddress" IN (
    '0x046da8955829adf2bda310099a0063451923f02e648cf25a1203aac6335cf0e4',
    '0x00539f522b29ae9251dbf7443c7a950cf260372e69efab3710a11bf17a9599f1'
  );
