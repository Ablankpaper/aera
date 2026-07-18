export interface RuntimeRunLease {
  attachAbort(abort: () => void): void;
  finish(): void;
}

interface RuntimeRunState {
  abort: (() => void) | null;
  abortRequested: boolean;
}

export class RuntimeActivityCoordinator {
  private readonly runs = new Map<string, RuntimeRunState>();
  private transitionPending = false;

  get activeRunCount(): number {
    return this.runs.size;
  }

  beginRun(runId: string): RuntimeRunLease | null {
    if (this.transitionPending) return null;

    const existing = this.runs.get(runId);
    if (existing !== undefined) this.requestAbort(existing);

    const state: RuntimeRunState = {
      abort: null,
      abortRequested: false,
    };
    this.runs.set(runId, state);

    return {
      attachAbort: (abort) => {
        state.abort = abort;
        if (state.abortRequested) abort();
      },
      finish: () => {
        if (this.runs.get(runId) === state) this.runs.delete(runId);
      },
    };
  }

  abortRun(runId: string): void {
    const state = this.runs.get(runId);
    if (state !== undefined) this.requestAbort(state);
  }

  abortAll(): void {
    for (const state of this.runs.values()) this.requestAbort(state);
    this.runs.clear();
  }

  beginTransition(): boolean {
    if (this.transitionPending || this.runs.size > 0) return false;
    this.transitionPending = true;
    return true;
  }

  cancelTransition(): void {
    this.transitionPending = false;
  }

  private requestAbort(state: RuntimeRunState): void {
    state.abortRequested = true;
    state.abort?.();
  }
}
