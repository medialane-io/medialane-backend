import prisma from "../../db/client.js";

export interface NonceStore {
  /** Atomically record a nonce. Returns false if already seen (replay). */
  consume(nonce: string, expiresAt: Date): Promise<boolean>;
}

export const prismaNonceStore: NonceStore = {
  async consume(nonce, expiresAt) {
    try {
      await prisma.adminAuthNonce.create({ data: { nonce, expiresAt } });
      // opportunistic cleanup of expired rows (cheap, bounded window)
      void prisma.adminAuthNonce
        .deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch(() => {});
      return true;
    } catch {
      return false; // unique violation on PK = replay
    }
  },
};
