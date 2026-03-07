const CURRENCY_DECIMALS: Record<string, number> = {
  USDC: 6,
  "USDC.E": 6,
  USDT: 6,
  ETH: 18,
  STRK: 18,
};

export function serializeToken(token: any, activeOrders: any[]) {
  return {
    id: token.id,
    chain: token.chain,
    contractAddress: token.contractAddress,
    tokenId: token.tokenId,
    owner: token.owner,
    tokenUri: token.tokenUri,
    metadataStatus: token.metadataStatus,
    metadata: {
      name: token.name,
      description: token.description,
      image: token.image,
      attributes: token.attributes,
      ipType: token.ipType,
      licenseType: token.licenseType,
      commercialUse: token.commercialUse,
      author: token.author,
    },
    activeOrders: activeOrders.map(serializeOrder),
    createdAt: token.createdAt,
    updatedAt: token.updatedAt,
  };
}

export function serializeOrder(o: any) {
  return {
    id: o.id,
    chain: o.chain,
    orderHash: o.orderHash,
    offerer: o.offerer,
    offer: {
      itemType: o.offerItemType,
      token: o.offerToken,
      identifier: o.offerIdentifier,
      startAmount: o.offerStartAmount,
      endAmount: o.offerEndAmount,
    },
    consideration: {
      itemType: o.considerationItemType,
      token: o.considerationToken,
      identifier: o.considerationIdentifier,
      startAmount: o.considerationStartAmount,
      endAmount: o.considerationEndAmount,
      recipient: o.considerationRecipient,
    },
    startTime: o.startTime.toString(),
    endTime: o.endTime.toString(),
    status: o.status,
    fulfiller: o.fulfiller,
    nftContract: o.nftContract,
    nftTokenId: o.nftTokenId,
    price: {
      raw: o.priceRaw,
      formatted: o.priceFormatted,
      currency: o.currencySymbol,
      decimals: CURRENCY_DECIMALS[(o.currencySymbol ?? "").toUpperCase()] ?? 18,
    },
    txHash: {
      created: o.createdTxHash,
      fulfilled: o.fulfilledTxHash,
      cancelled: o.cancelledTxHash,
    },
    createdBlockNumber: o.createdBlockNumber.toString(),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
