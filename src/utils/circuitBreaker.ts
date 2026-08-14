

import { createLogger } from "./logger.js";

const log = createLogger("circuit-breaker");

const FAILURE_THRESHOLD = 5;
const RECOVERY_MS = 60_000;

type State = "CLOSED" | "OPEN" | "HALF";

export class CircuitBreaker {
  private state: State = "CLOSED";
  private failures = 0;
  private openedAt = 0;

  recordSuccess(): void {
    if (this.state === "HALF") {

      log.info({ from: this.state }, "Circuit breaker: primary recovered, closing");
      this.state = "CLOSED";
      this.failures = 0;
    } else if (this.state === "CLOSED") {
      this.failures = 0;
    }

  }

  recordFailure(): void {
    this.failures++;
    if (this.state === "CLOSED" && this.failures >= FAILURE_THRESHOLD) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      log.warn({ failures: this.failures }, "Circuit breaker: opening — too many RPC failures");
    } else if (this.state === "HALF") {

      this.state = "OPEN";
      this.openedAt = Date.now();
      log.warn("Circuit breaker: probe failed — reopening");
    }
  }

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

    return true;
  }
}
