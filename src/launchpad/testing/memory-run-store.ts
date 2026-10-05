import type { RunStore, StoredRun } from "../run-store.js";

type Path = string[];

const getPath = (obj: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    obj,
  );

const setPath = (obj: Record<string, unknown>, path: Path, value: unknown) => {
  const parent = getPath(obj, path.slice(0, -1));
  if (!parent || typeof parent !== "object") return;
  (parent as Record<string, unknown>)[path[path.length - 1]!] = value;
};

const deletePath = (obj: Record<string, unknown>, path: Path) => {
  const parent = getPath(obj, path.slice(0, -1)) as Record<string, unknown> | undefined;
  if (parent) delete parent[path[path.length - 1]!];
};

export interface MemoryRunStore extends RunStore {
  runs: StoredRun[];
  balances: Map<string, number>;
  usage: { apiCreditsId: string; actionKey: string; credits: number }[];
  refunds: number[];
  wallets: Set<string>;
}

export function createMemoryRunStore(
  options: { balances?: Record<string, number>; wallets?: string[]; provisioned?: number; now?: () => Date } = {},
): MemoryRunStore {
  const runs: StoredRun[] = [];
  const balances = new Map(Object.entries(options.balances ?? {}));
  const usage: MemoryRunStore["usage"] = [];
  const refunds: number[] = [];
  const wallets = new Set(options.wallets ?? []);
  const now = options.now ?? (() => new Date());
  let n = 0;

  const find = (id: string, apiCreditsId: string) => runs.find((r) => r.id === id && r.apiCreditsId === apiCreditsId);
  const withStatus = (id: string, apiCreditsId: string, ...statuses: StoredRun["status"][]) => {
    const run = find(id, apiCreditsId);
    return run && statuses.includes(run.status) ? run : undefined;
  };

  return {
    runs,
    balances,
    usage,
    refunds,
    wallets,

    async create({ apiCreditsId, service, spec }) {
      const now = new Date();
      const run: StoredRun = {
        id: `run${++n}`,
        apiCreditsId,
        service,
        status: "DRAFT",
        spec,
        quote: null,
        creditsHeld: 0,
        creditsSpent: 0,
        progress: {},
        createdAt: now,
        updatedAt: now,
      };
      runs.push(run);
      return run;
    },

    async updateDraft(id, apiCreditsId, spec) {
      const run = withStatus(id, apiCreditsId, "DRAFT");
      if (!run) return null;
      run.spec = spec;
      return run;
    },

    async get(id, apiCreditsId) {
      return find(id, apiCreditsId) ?? null;
    },

    async list(apiCreditsId) {
      return runs.filter((r) => r.apiCreditsId === apiCreditsId);
    },

    async cancelDraft(id, apiCreditsId) {
      const run = withStatus(id, apiCreditsId, "DRAFT");
      if (!run) return null;
      run.status = "CANCELLED";
      return run;
    },

    async countProvisioned() {
      return options.provisioned ?? 0;
    },

    async checkout({ id, apiCreditsId, quote, progress }) {
      const run = withStatus(id, apiCreditsId, "DRAFT");
      if (!run) return "not-draft";
      const balance = balances.get(apiCreditsId) ?? 0;
      if (balance < quote.total) return "insufficient";
      balances.set(apiCreditsId, balance - quote.total);
      Object.assign(run, { status: "PAID", quote, creditsHeld: quote.total, progress: structuredClone(progress) });
      for (const line of quote.lines) usage.push({ apiCreditsId, actionKey: line.action, credits: line.credits });
      return "paid";
    },

    async balance(apiCreditsId) {
      return balances.get(apiCreditsId) ?? 0;
    },

    async reserve({ id, apiCreditsId, credits, path, retryReverted }) {
      const run = withStatus(id, apiCreditsId, "PAID", "RUNNING");
      if (!run || run.creditsSpent + credits > run.creditsHeld) return false;
      const current = getPath(run.progress, path) as { status?: string } | undefined;
      const reverted = retryReverted && current?.status === "REVERTED";
      if (current !== undefined && !reverted) return false;
      run.creditsSpent += credits;
      run.status = "RUNNING";
      setPath(run.progress as Record<string, unknown>, path, { status: "PENDING", at: now().toISOString(), credits });
      return true;
    },

    async record(id, apiCreditsId, path, value) {
      const run = find(id, apiCreditsId);
      if (run) setPath(run.progress as Record<string, unknown>, path, structuredClone(value));
    },

    async sweepStale({ id, apiCreditsId, paths, olderThanMs }) {
      const run = withStatus(id, apiCreditsId, "PAID", "RUNNING");
      if (!run) return 0;
      let released = 0;
      for (const path of paths) {
        const marker = getPath(run.progress, path) as { status?: string; at?: string; credits?: number } | undefined;
        if (marker?.status !== "PENDING" || !marker.at || typeof marker.credits !== "number") continue;
        if (now().getTime() - Date.parse(marker.at) <= olderThanMs) continue;
        run.creditsSpent = Math.max(0, run.creditsSpent - marker.credits);
        deletePath(run.progress as Record<string, unknown>, path);
        released++;
      }
      return released;
    },

    async release({ id, apiCreditsId, credits, path }) {
      const run = find(id, apiCreditsId);
      if (!run) return;
      run.creditsSpent = Math.max(0, run.creditsSpent - credits);
      deletePath(run.progress as Record<string, unknown>, path);
    },

    async ownsWallet(accountId, address) {
      return wallets.has(`${accountId}:${address}`);
    },

    async complete({ id, apiCreditsId, status }) {
      const run = withStatus(id, apiCreditsId, "PAID", "RUNNING");
      if (!run) return null;
      run.status = status;
      const refunded = Math.max(0, run.creditsHeld - run.creditsSpent);
      balances.set(apiCreditsId, (balances.get(apiCreditsId) ?? 0) + refunded);
      if (refunded > 0) usage.push({ apiCreditsId, actionKey: "launchpad:refund", credits: -refunded });
      refunds.push(refunded);
      return { refunded };
    },
  };
}
