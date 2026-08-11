import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import {
  serializeDesktopControlPublicState,
  type DesktopControlPublicErrorCode,
  type DesktopControlPublicState,
  type DesktopHealthSummary,
} from "../../shared/agentera-desktop-control";
import {
  AgenteraDesktopControlError,
  type DesktopCommand,
  type DesktopCommandResultRequest,
  type DesktopHeartbeatReceipt,
  type DesktopHeartbeatRequest,
} from "./client";
import type { DesktopHealthResult } from "./health";
import type {
  DesktopControlJournalRecord,
  DesktopControlPrincipalKey,
  DesktopControlTerminalResult,
} from "./store";

const RETRY_SECONDS = [5, 15, 30, 60] as const;
const TERMINAL_CODES = new Set([
  "session_revoked",
  "device_not_found",
  "account_disabled",
  "account_pending_deletion",
]);

export interface DesktopControlAuthSource {
  getPublicState(): AgenteraAuthPublicState;
  subscribe(listener: (state: AgenteraAuthPublicState) => void): () => void;
}

export interface DesktopControlClientPort {
  heartbeat(
    input: DesktopHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<DesktopHeartbeatReceipt>;
  submitResult(
    commandId: string,
    input: DesktopCommandResultRequest,
    signal?: AbortSignal,
  ): Promise<DesktopCommand>;
}

export interface DesktopControlJournalPort {
  listPending(
    principal: DesktopControlPrincipalKey,
  ): DesktopControlJournalRecord[];
  markRunning(principal: DesktopControlPrincipalKey, commandId: string): void;
  saveTerminal(
    principal: DesktopControlPrincipalKey,
    commandId: string,
    result: DesktopControlTerminalResult,
  ): void;
  markDelivered(principal: DesktopControlPrincipalKey, commandId: string): void;
  close?(): void;
}

export interface DesktopControlHealthPort {
  run(): Promise<DesktopHealthResult>;
}

export interface AgenteraDesktopControlCoordinatorOptions {
  auth: DesktopControlAuthSource;
  client: DesktopControlClientPort;
  journal: DesktopControlJournalPort;
  health: DesktopControlHealthPort;
  getHeartbeatMetadata: () => Omit<DesktopHeartbeatRequest, "health">;
  now?: () => Date;
}

export class AgenteraDesktopControlCoordinator {
  private readonly options: AgenteraDesktopControlCoordinatorOptions;
  private readonly listeners = new Set<
    (state: DesktopControlPublicState) => void
  >();
  private state: DesktopControlPublicState = {
    status: "unregistered",
    lastHeartbeatAt: null,
    lastErrorCode: null,
    lastHealth: null,
  };
  private lastHealthSummary: DesktopHealthSummary | null = null;
  private unsubscribe: (() => void) | null = null;
  private principal: DesktopControlPrincipalKey | null = null;
  private abortController: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private retryIndex = 0;
  private closed = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: AgenteraDesktopControlCoordinatorOptions) {
    this.options = options;
  }

  start(): void {
    if (this.closed || this.unsubscribe) return;
    this.unsubscribe = this.options.auth.subscribe((state) =>
      this.onAuthState(state),
    );
    this.onAuthState(this.options.auth.getPublicState());
  }

  getPublicState(): DesktopControlPublicState {
    return serializeDesktopControlPublicState(this.state);
  }

  subscribe(listener: (state: DesktopControlPublicState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopSession();
    await Promise.allSettled([...this.inFlight]);
    this.options.journal.close?.();
    this.listeners.clear();
  }

  private onAuthState(state: AgenteraAuthPublicState): void {
    if (this.closed) return;
    if (state.status === "authenticated" && state.cloudAvailable) {
      const next = { userId: state.userId, deviceId: state.deviceId };
      if (
        this.principal?.userId === next.userId &&
        this.principal.deviceId === next.deviceId &&
        this.abortController !== null
      ) {
        return;
      }
      this.stopSession();
      this.principal = next;
      this.abortController = new AbortController();
      this.retryIndex = 0;
      this.publish({ status: "connecting", lastErrorCode: null });
      this.recoverInterrupted(next);
      this.track(this.runHeartbeat(this.generation, next));
      return;
    }

    this.stopSession();
    this.principal = null;
    this.lastHealthSummary = null;
    this.publish({
      status:
        state.status === "offline" ||
        (state.status === "authenticated" && !state.cloudAvailable)
          ? "offline"
          : state.status === "checking"
            ? "connecting"
            : "needs_reauth",
      lastErrorCode: null,
    });
  }

  private stopSession(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abortController?.abort();
    this.abortController = null;
  }

  private recoverInterrupted(principal: DesktopControlPrincipalKey): void {
    for (const record of this.options.journal.listPending(principal)) {
      if (record.state !== "running") continue;
      const completedAt = this.now().toISOString();
      this.options.journal.saveTerminal(principal, record.commandId, {
        state: "failed",
        code: "CLIENT_INTERRUPTED",
        summary: {
          desktop_status: "degraded",
          runtime_status: "unknown",
          gateway_status: "unknown",
          code: "CLIENT_INTERRUPTED",
          duration_ms: 0,
        },
        completedAt,
      });
    }
  }

  private async runHeartbeat(
    generation: number,
    principal: DesktopControlPrincipalKey,
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || !this.current(generation, principal)) return;
    try {
      await this.replayPending(principal, signal);
      if (!this.current(generation, principal)) return;
      const metadata = this.options.getHeartbeatMetadata();
      const payload: DesktopHeartbeatRequest = this.lastHealthSummary
        ? { ...metadata, health: this.lastHealthSummary }
        : metadata;
      const receipt = await this.options.client.heartbeat(payload, signal);
      if (!this.current(generation, principal)) return;
      if (receipt.instance_id !== principal.deviceId) {
        throw new AgenteraDesktopControlError(200, "invalid_response");
      }
      this.retryIndex = 0;
      this.publish({
        status: receipt.effective_status === "online" ? "online" : "degraded",
        lastHeartbeatAt: new Date(receipt.accepted_at).toISOString(),
        lastErrorCode: null,
      });
      if (receipt.command) {
        await this.executeCommand(principal, receipt.command, signal);
      }
      if (this.current(generation, principal)) {
        this.schedule(
          generation,
          principal,
          receipt.next_heartbeat_seconds * 1000,
        );
      }
    } catch (error) {
      if (!this.current(generation, principal) || signal.aborted) return;
      const requestError =
        error instanceof AgenteraDesktopControlError
          ? error
          : new AgenteraDesktopControlError(0, "network_unavailable");
      const publicCode = this.publicErrorCode(requestError.code);
      if (TERMINAL_CODES.has(requestError.code)) {
        this.publish({ status: "needs_reauth", lastErrorCode: publicCode });
        return;
      }
      this.publish({
        status: this.state.lastHeartbeatAt ? "degraded" : "offline",
        lastErrorCode: publicCode,
      });
      const delaySeconds =
        requestError.retryAfterSeconds ??
        RETRY_SECONDS[Math.min(this.retryIndex, RETRY_SECONDS.length - 1)];
      this.retryIndex += 1;
      this.schedule(generation, principal, delaySeconds * 1000);
    }
  }

  private async replayPending(
    principal: DesktopControlPrincipalKey,
    signal: AbortSignal,
  ): Promise<void> {
    for (const record of this.options.journal.listPending(principal)) {
      if (record.state !== "terminal" || !record.result) continue;
      await this.options.client.submitResult(
        record.commandId,
        {
          state: record.result.state,
          code: record.result.code,
          summary: record.result.summary,
        },
        signal,
      );
      this.lastHealthSummary = record.result.summary;
      this.publish({
        lastHealth: {
          state: record.result.state,
          code: record.result.code,
          completedAt: record.result.completedAt,
        },
      });
      this.options.journal.markDelivered(principal, record.commandId);
    }
  }

  private async executeCommand(
    principal: DesktopControlPrincipalKey,
    command: DesktopCommand,
    signal: AbortSignal,
  ): Promise<void> {
    if (command.type !== "health_check" || command.state !== "claimed") return;
    const existing = this.options.journal
      .listPending(principal)
      .find((record) => record.commandId === command.command_id);
    if (existing?.state === "terminal") {
      await this.replayPending(principal, signal);
      return;
    }
    if (existing?.state === "running") return;
    this.options.journal.markRunning(principal, command.command_id);
    await this.options.client.submitResult(
      command.command_id,
      { state: "running", code: null, summary: null },
      signal,
    );
    const result = await this.options.health.run();
    const terminal: DesktopControlTerminalResult = {
      ...result,
      completedAt: this.now().toISOString(),
    };
    this.options.journal.saveTerminal(principal, command.command_id, terminal);
    this.lastHealthSummary = terminal.summary;
    this.publish({
      lastHealth: {
        state: terminal.state,
        code: terminal.code,
        completedAt: terminal.completedAt,
      },
    });
    await this.options.client.submitResult(
      command.command_id,
      {
        state: terminal.state,
        code: terminal.code,
        summary: terminal.summary,
      },
      signal,
    );
    this.options.journal.markDelivered(principal, command.command_id);
  }

  private schedule(
    generation: number,
    principal: DesktopControlPrincipalKey,
    delayMs: number,
  ): void {
    if (!this.current(generation, principal)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.track(this.runHeartbeat(generation, principal));
      },
      Math.max(1, Math.min(300_000, delayMs)),
    );
  }

  private current(
    generation: number,
    principal: DesktopControlPrincipalKey,
  ): boolean {
    return (
      !this.closed &&
      this.generation === generation &&
      this.principal?.userId === principal.userId &&
      this.principal.deviceId === principal.deviceId
    );
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private publish(patch: Partial<DesktopControlPublicState>): void {
    this.state = serializeDesktopControlPublicState({
      ...this.state,
      ...patch,
    });
    const publicState = this.getPublicState();
    for (const listener of this.listeners) listener(publicState);
  }

  private publicErrorCode(code: string): DesktopControlPublicErrorCode {
    switch (code) {
      case "network_unavailable":
      case "rate_limited":
      case "service_unavailable":
      case "session_revoked":
      case "device_not_found":
      case "account_disabled":
      case "account_pending_deletion":
      case "request_timeout":
        return code;
      default:
        return "invalid_response";
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
