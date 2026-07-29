export interface RuntimeRunLease {
  attachAbort(abort: () => void): void;
  finish(): void;
}

export interface RuntimeSnapshotLease {
  finish(): void;
}

interface RuntimeRunState {
  abort: (() => void) | null;
  abortRequested: boolean;
}

export class RuntimeActivityCoordinator {
  private readonly currentRuns = new Map<string, RuntimeRunState>();
  private readonly activeRuns = new Set<RuntimeRunState>();
  private transitionPending = false;
  private snapshotPending = false;

  get activeRunCount(): number {
    return this.activeRuns.size;
  }

  get snapshotActive(): boolean {
    return this.snapshotPending;
  }

  beginRun(runId: string): RuntimeRunLease | null {
    if (this.transitionPending || this.snapshotPending) return null;

    const existing = this.currentRuns.get(runId);
    if (existing !== undefined) this.requestAbort(existing);

    const state: RuntimeRunState = {
      abort: null,
      abortRequested: false,
    };
    this.currentRuns.set(runId, state);
    this.activeRuns.add(state);

    return {
      attachAbort: (abort) => {
        state.abort = abort;
        if (state.abortRequested) abort();
      },
      finish: () => {
        this.activeRuns.delete(state);
        if (this.currentRuns.get(runId) === state) {
          this.currentRuns.delete(runId);
        }
      },
    };
  }

  abortRun(runId: string): void {
    const state = this.currentRuns.get(runId);
    if (state !== undefined) this.requestAbort(state);
  }

  abortAll(): void {
    for (const state of this.activeRuns) this.requestAbort(state);
  }

  beginTransition(): boolean {
    if (
      this.transitionPending ||
      this.snapshotPending ||
      this.activeRuns.size > 0
    ) {
      return false;
    }
    this.transitionPending = true;
    return true;
  }

  cancelTransition(): void {
    this.transitionPending = false;
  }

  beginSnapshot(): RuntimeSnapshotLease | null {
    if (
      this.snapshotPending ||
      this.transitionPending ||
      this.activeRuns.size > 0
    ) {
      return null;
    }
    this.snapshotPending = true;
    let finished = false;
    return {
      finish: () => {
        if (finished) return;
        finished = true;
        this.snapshotPending = false;
      },
    };
  }

  async withSnapshot<T>(operation: () => Promise<T> | T): Promise<T> {
    const lease = this.beginSnapshot();
    if (!lease) {
      throw new Error("Aera Runtime is busy.");
    }
    try {
      return await operation();
    } finally {
      lease.finish();
    }
  }

  private requestAbort(state: RuntimeRunState): void {
    state.abortRequested = true;
    state.abort?.();
  }
}
