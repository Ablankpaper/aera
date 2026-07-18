const DEFAULT_ROLLBACK_TOLERANCE_MS = 2 * 60 * 1000;

export interface AgenteraTrustedTimeAnchorOptions {
  trustedServerTime: string;
  wallNow?: () => number;
  monotonicNow?: () => number;
  rollbackToleranceMs?: number;
  detectInitialRollback?: boolean;
}

export interface AgenteraTrustedTimeEvaluation {
  trustedNow: Date;
  rollbackDetected: boolean;
}

function parseTrustedServerTime(value: string): number {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("AgentEra trusted server time is invalid.");
  }
  return parsed.getTime();
}

/**
 * Combines a server-anchored wall clock with a monotonic elapsed-time floor.
 * The floor prevents a stalled local clock from extending a seven-day token;
 * explicit rollback beyond tolerance requires online validation.
 */
export class AgenteraTrustedTimeAnchor {
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly rollbackToleranceMs: number;
  private readonly detectInitialRollback: boolean;
  private trustedAtReset = 0;
  private wallAtReset = 0;
  private monotonicAtReset = 0;
  private lastWall = 0;
  private lastMonotonic = 0;

  constructor(options: AgenteraTrustedTimeAnchorOptions) {
    this.wallNow = options.wallNow ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.rollbackToleranceMs =
      options.rollbackToleranceMs ?? DEFAULT_ROLLBACK_TOLERANCE_MS;
    this.detectInitialRollback = options.detectInitialRollback ?? true;
    if (
      !Number.isFinite(this.rollbackToleranceMs) ||
      this.rollbackToleranceMs < 0 ||
      this.rollbackToleranceMs > 60 * 60 * 1000
    ) {
      throw new Error("AgentEra clock rollback tolerance is invalid.");
    }
    this.reset(options.trustedServerTime);
  }

  reset(trustedServerTime: string): void {
    const trusted = parseTrustedServerTime(trustedServerTime);
    const wall = this.wallNow();
    const monotonic = this.monotonicNow();
    if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) {
      throw new Error("AgentEra trusted time clocks are unavailable.");
    }
    this.trustedAtReset = trusted;
    this.wallAtReset = wall;
    this.monotonicAtReset = monotonic;
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
  }

  evaluate(): AgenteraTrustedTimeEvaluation {
    const wall = this.wallNow();
    const monotonic = this.monotonicNow();
    if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) {
      return {
        trustedNow: new Date(this.trustedAtReset),
        rollbackDetected: true,
      };
    }

    const monotonicElapsed = monotonic - this.monotonicAtReset;
    const rollbackDetected =
      (this.detectInitialRollback &&
        wall + this.rollbackToleranceMs < this.trustedAtReset) ||
      wall + this.rollbackToleranceMs < this.wallAtReset ||
      wall + this.rollbackToleranceMs < this.lastWall ||
      monotonic < this.monotonicAtReset ||
      monotonic < this.lastMonotonic;
    const projectedTrusted =
      this.trustedAtReset + Math.max(0, monotonicElapsed);
    const trustedNow = new Date(Math.max(wall, projectedTrusted));

    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    return { trustedNow, rollbackDetected };
  }
}
