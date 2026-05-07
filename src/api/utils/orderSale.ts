import type { OrderStatus, Prisma } from "@prisma/client";

export const PARTIAL_ERC1155_SALE_WHERE = {
  status: "ACTIVE",
  fulfiller: { not: null },
  remainingAmount: { not: null },
  OR: [{ offerItemType: "ERC1155" }, { considerationItemType: "ERC1155" }],
} satisfies Prisma.OrderWhereInput;

export const SALE_ORDER_WHERE = {
  OR: [{ status: "FULFILLED" }, PARTIAL_ERC1155_SALE_WHERE],
} satisfies Prisma.OrderWhereInput;

export const ACTIVE_LISTING_ACTIVITY_WHERE = {
  status: "ACTIVE",
  offerItemType: { in: ["ERC721", "ERC1155"] },
  NOT: [PARTIAL_ERC1155_SALE_WHERE],
} satisfies Prisma.OrderWhereInput;

export const ACTIVE_OFFER_ACTIVITY_WHERE = {
  status: "ACTIVE",
  offerItemType: "ERC20",
  NOT: [PARTIAL_ERC1155_SALE_WHERE],
} satisfies Prisma.OrderWhereInput;

type OrderSaleFields = {
  status: OrderStatus | string;
  offerItemType: string;
  considerationItemType: string;
  fulfiller: string | null;
  remainingAmount: string | null;
};

export function isPartialErc1155Sale(order: OrderSaleFields): boolean {
  return (
    order.status === "ACTIVE" &&
    order.fulfiller != null &&
    order.remainingAmount != null &&
    (order.offerItemType === "ERC1155" || order.considerationItemType === "ERC1155")
  );
}

export function isOrderSale(order: OrderSaleFields): boolean {
  return order.status === "FULFILLED" || isPartialErc1155Sale(order);
}
