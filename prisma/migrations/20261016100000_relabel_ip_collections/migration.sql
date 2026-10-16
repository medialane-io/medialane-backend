UPDATE "Collection"
SET service = 'mip-erc721', "updatedAt" = CURRENT_TIMESTAMP
WHERE chain = 'STARKNET'
  AND service = 'data-tokenization-erc721'
  AND "contractAddress" IN (
    '0x04b2bae4811762759c5ff219b34998336875736cc9e8bc10f999afe5e4304cac',
    '0x0669de8cd19eecc84b7fd7a9962938e19ab073cecf1b7141f84562d1804cd478',
    '0x06e0135edcaee615ee3023947786b044113b67ce94e22e6d7795d634b0a709e9',
    '0x039aa22a67a29527bd43fa401e18eab1815140cfe0da0d9bec740e1dc7dc879e',
    '0x041908487696c3f037aa8ba12d5e15f4ea1d1aaca3ac1e0e6d08ccc31832a9d4',
    '0x04eabdb41fbe78f5ca40c0d25d4f24f73dbc4978fb135b4dcdb7bf8c143902e4',
    '0x01b95b984f76c8a82e32dcdf21bbd6b2b480388da09db2c0ec43d3beafdc5038'
  );
