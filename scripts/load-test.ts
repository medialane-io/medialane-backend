const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? "https://api.medialane.io/v1";
const API_KEY = process.env.LOAD_TEST_API_KEY;
if (!API_KEY) {
  console.error("LOAD_TEST_API_KEY is required");
  process.exit(1);
}

const DUMMY_OWNER = "0x00000000000000000000000000000000000000000000000000000000000001";

interface RunResult {
  label: string;
  status: number | "error";
  ms: number;
}

async function timedRequest(label: string, path: string, init?: RequestInit): Promise<RunResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { "x-api-key": API_KEY!, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    await res.text();
    return { label, status: res.status, ms: performance.now() - start };
  } catch {
    return { label, status: "error", ms: performance.now() - start };
  }
}

function summarize(label: string, results: RunResult[]) {
  const ok = results.filter((r) => typeof r.status === "number" && r.status < 400).length;
  const rateLimited = results.filter((r) => r.status === 429).length;
  const serverErrors = results.filter((r) => typeof r.status === "number" && r.status >= 500).length;
  const errors = results.filter((r) => r.status === "error").length;
  const durations = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
  const statusCounts = results.reduce<Record<string, number>>((acc, r) => {
    const key = String(r.status);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\n=== ${label} ===`);
  console.log(`total=${results.length} ok=${ok} rateLimited=${rateLimited} serverErrors=${serverErrors} networkErrors=${errors}`);
  console.log(`p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`);
  console.log(`statusCounts=${JSON.stringify(statusCounts)}`);
}

async function runConcurrent(count: number, concurrency: number, fn: (i: number) => Promise<RunResult>): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let next = 0;
  async function worker() {
    while (next < count) {
      const i = next++;
      results.push(await fn(i));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function phaseReads() {
  const READ_COUNT = 300;
  const READ_CONCURRENCY = 40;

  const paths = [
    "/collections",
    "/activities",
    "/search?q=lunar",
    "/stats",
  ];

  const results = await runConcurrent(READ_COUNT, READ_CONCURRENCY, (i) =>
    timedRequest("read", paths[i % paths.length]!)
  );
  summarize("Read-heavy browsing (collections/activities/search/stats)", results);
}

async function phaseWrites() {
  const WRITE_COUNT = 10;
  const WRITE_CONCURRENCY = 5;

  const results = await runConcurrent(WRITE_COUNT, WRITE_CONCURRENCY, async (i) => {
    const buildRes = await timedRequest("create-collection:build", "/intents/create-collection", {
      method: "POST",
      body: JSON.stringify({
        owner: DUMMY_OWNER,
        name: `Load Test Collection ${Date.now()}-${i}`,
        symbol: `LT${i}`,
      }),
    });
    return buildRes;
  });
  summarize("Write path: /intents/create-collection (build only, no on-chain execute)", results);

  // Re-run through the actual calls once to also exercise paymaster/invoke/build
  // (still stops short of /execute — no real transaction, no real gas spent).
  const paymasterResults = await runConcurrent(WRITE_COUNT, WRITE_CONCURRENCY, async (i) => {
    const build = await fetch(`${BASE_URL}/intents/create-collection`, {
      method: "POST",
      headers: { "x-api-key": API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({
        owner: DUMMY_OWNER,
        name: `Load Test Collection PM ${Date.now()}-${i}`,
        symbol: `LTP${i}`,
      }),
    });
    const body = (await build.json()) as { data?: { calls?: unknown } };
    if (!body.data?.calls) return { label: "paymaster:build", status: build.status, ms: 0 };

    return timedRequest("paymaster:build", "/paymaster/invoke/build", {
      method: "POST",
      body: JSON.stringify({ userAddress: DUMMY_OWNER, calls: body.data.calls }),
    });
  });
  summarize("Write path: paymaster/invoke/build (still no /execute)", paymasterResults);
}

async function main() {
  console.log(`Load test against ${BASE_URL}`);
  await phaseReads();
  await phaseWrites();
}

main();
