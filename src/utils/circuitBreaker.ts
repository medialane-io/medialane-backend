/**
 * Lightweight circuit breaker for RPC provider calls.
 *
 * States:
 *   CLOSED  — primary is healthy; all calls go to primary
 *   OPEN    — primary is failing; calls go to fallback (if available)
 *   HALF    — cool-down elapsed; one probe sent to primary to test recovery
 *
 * If no fallback URL is configured the breaker still tracks failures but
 * lets calls through to the primary regardless of state (degraded mode).
 */

import { createLogger } from "./logger.js";

const log = createLogger("circuit-breaker");

const FAILURE_THRESHOLD = 5;   // consecutive failures to open the circuit
const RECOVERY_MS = 60_000;    // 1 minute before probing primary again

type State = "CLOSED" | "OPEN" | "HALF";

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failures = 0;
  private openedAt = 0;

  recordSuccess(): void {
    if (this.state !== "CLOSED") {
      log.info({ from: this.state }, "Circuit breaker: primary recovered, closing");
    }
    this.state = "CLOSED";
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === "CLOSED" && this.failures >= FAILURE_THRESHOLD) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      log.warn({ failures: this.failures }, "Circuit breaker: opening — too many RPC failures");
    } else if (this.state === "HALF") {
      // Probe failed — stay open a bit longer
      this.state = "OPEN";
      this.openedAt = Date.now();
      log.warn("Circuit breaker: probe failed — reopening");
    }
  }

  /** Returns true when the primary should be attempted. */
  shouldUsePrimary(): boolean {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() - this.openedAt >= RECOVERY_MS) {
        this.state = "HALF";
        log.info("Circuit breaker: entering HALF-OPEN — probing primary");
        return true;
      }
      return false;
    }
    // HALF — already probing
    return true;
  }
}
