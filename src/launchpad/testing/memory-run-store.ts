import type { RunStore, StoredRun } from "../run-store.js";

type Path = string[];

const getPath = (obj: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    obj,
  );

const setPath = (obj: Record<string, unknown>, path: Path, value: unknown) => {
  let node = obj;
  for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
  node[path[path.length - 1]!] = value;
};

const deletePath = (obj: Record<string, unknown>, path: Path) => {
  const parent = getPath(obj, path.slice(0, -1)) as Record<string, unknown> | undefined;
  if (parent) delete parent[path[path.length - 1]!];
};

export interface MemoryRunStore extends RunStore {
  runs: StoredRun[];
  balances: Map<string, number>;
  usage: { apiClientId: string; actionKey: string; credits: number }[];
  refunds: number[];
  wallets: Set<string>;
}

export function createMemoryRunStore(
  options: { balances?: Record<string, number>; wallets?: string[]; provisioned?: number } = {},
): MemoryRunStore {
  const runs: StoredRun[] = [];
  const balances = new Map(Object.entries(options.balances ?? {}));
  const usage: MemoryRunStore["usage"] = [];
  const refunds: number[] = [];
  const wallets = new Set(options.wallets ?? []);
  let n = 0;

  const find = (id: string, apiClientId: string) => runs.find((r) => r.id === id && r.apiClientId === apiClientId);
  const withStatus = (id: string, apiClientId: string, ...statuses: StoredRun["status"][]) => {
    const run = find(id, apiClientId);
    return run && statuses.includes(run.status) ? run : undefined;
  };

  return {
    runs,
    balances,
    usage,
    refunds,
    wallets,

    async create({ apiClientId, service, spec }) {
      const now = new Date();
      const run: StoredRun = {
        id: `run${++n}`,
        apiClientId,
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

    async updateDraft(id, apiClientId, spec) {
      const run = withStatus(id, apiClientId, "DRAFT");
      if (!run) return null;
      run.spec = spec;
      return run;
    },

    async get(id, apiClientId) {
      return find(id, apiClientId) ?? null;
    },

    async list(apiClientId) {
      return runs.filter((r) => r.apiClientId === apiClientId);
    },

    async cancelDraft(id, apiClientId) {
      const run = withStatus(id, apiClientId, "DRAFT");
      if (!run) return null;
      run.status = "CANCELLED";
      return run;
    },

    async countProvisioned() {
      return options.provisioned ?? 0;
    },

    async checkout({ id, apiClientId, quote, progress }) {
      const run = withStatus(id, apiClientId, "DRAFT");
      if (!run) return "not-draft";
      const balance = balances.get(apiClientId) ?? 0;
      if (balance < quote.total) return "insufficient";
      balances.set(apiClientId, balance - quote.total);
      Object.assign(run, { status: "PAID", quote, creditsHeld: quote.total, progress: structuredClone(progress) });
      for (const line of quote.lines) usage.push({ apiClientId, actionKey: line.action, credits: line.credits });
      return "paid";
    },

    async balance(apiClientId) {
      return balances.get(apiClientId) ?? 0;
    },

    async reserve({ id, apiClientId, credits, path, retryReverted }) {
      const run = withStatus(id, apiClientId, "PAID", "RUNNING");
      if (!run || run.creditsSpent + credits > run.creditsHeld) return false;
      const current = getPath(run.progress, path) as { status?: string } | undefined;
      const reverted = retryReverted && current?.status === "REVERTED";
      if (current !== undefined && !reverted) return false;
      run.creditsSpent += credits;
      run.status = "RUNNING";
      setPath(run.progress as Record<string, unknown>, path, { status: "PENDING" });
      return true;
    },

    async record(id, apiClientId, path, value) {
      const run = find(id, apiClientId);
      if (run) setPath(run.progress as Record<string, unknown>, path, structuredClone(value));
    },

    async release({ id, apiClientId, credits, path }) {
      const run = find(id, apiClientId);
      if (!run) return;
      run.creditsSpent = Math.max(0, run.creditsSpent - credits);
      deletePath(run.progress as Record<string, unknown>, path);
    },

    async ownsWallet(accountId, address) {
      return wallets.has(`${accountId}:${address}`);
    },

    async complete({ id, apiClientId, status }) {
      const run = withStatus(id, apiClientId, "PAID", "RUNNING");
      if (!run) return null;
      run.status = status;
      const refunded = Math.max(0, run.creditsHeld - run.creditsSpent);
      balances.set(apiClientId, (balances.get(apiClientId) ?? 0) + refunded);
      if (refunded > 0) usage.push({ apiClientId, actionKey: "launchpad:refund", credits: -refunded });
      refunds.push(refunded);
      return { refunded };
    },
  };
}
