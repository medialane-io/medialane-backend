import prisma from "../../db/client.js";

export interface NonceStore {

  consume(nonce: string, expiresAt: Date): Promise<boolean>;
}

export const prismaNonceStore: NonceStore = {
  async consume(nonce, expiresAt) {
    try {
      await prisma.adminAuthNonce.create({ data: { nonce, expiresAt } });

      void prisma.adminAuthNonce
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch(() => {});
      return true;
    } catch {
      return false;
    }
  },
};
