UPDATE "Collection" SET "isHidden" = true
WHERE "chain" = 'STARKNET' AND "contractAddress" IN (
  '0x06dc194510ea3f07011790a5ccc088d06e5f1f7d04365a3cd2d653bb9a992e00',
  '0x06314b00371788859b38ee3d46c58ad79f0391714e1aa5377aed7d3e4a494eaf'
);
UPDATE "Token" SET "isHidden" = true
WHERE "chain" = 'STARKNET' AND "contractAddress" IN (
  '0x06dc194510ea3f07011790a5ccc088d06e5f1f7d04365a3cd2d653bb9a992e00',
  '0x06314b00371788859b38ee3d46c58ad79f0391714e1aa5377aed7d3e4a494eaf'
);
