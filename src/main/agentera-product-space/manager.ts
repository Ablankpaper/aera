import type { AgenteraAuthPublicState } from "../../shared/agentera-auth";
import type { OrganizationPublicState } from "../../shared/agentera-organization";
import type {
  ProductSpaceAgentContext,
  ProductSpaceOption,
  ProductSpacePublicState,
  ProductSpaceSelection,
  StoredProductSpaceSelection,
} from "../../shared/agentera-product-space";
import type { WorkspacePublicState } from "../../shared/agentera-workspace";
import type { AgenteraProductSpaceDatabase } from "./db";
import { LEGACY_WORKSPACE_SELECTION_MIGRATION } from "./db";

export interface AgenteraProductSpaceStateSource<T> {
  getState(): Promise<T>;
  refresh(): Promise<T>;
  subscribe(listener: () => void): () => void;
}

export interface AgenteraProductSpaceManagerOptions {
  database: AgenteraProductSpaceDatabase;
  workspaceSource: AgenteraProductSpaceStateSource<WorkspacePublicState>;
  organizationSource: AgenteraProductSpaceStateSource<OrganizationPublicState>;
  getLegacyWorkspaceSelection: (accountUserId: string) => string | null;
  getAuthState: () => AgenteraAuthPublicState;
  now?: () => string;
}

export type ProductSpaceSelectionInput =
  | { kind: "PERSONAL" }
  | { kind: "WORKSPACE"; workspaceId: string }
  | { kind: "ORGANIZATION"; organizationId: string };

type ProductAccess = Extract<
  AgenteraAuthPublicState,
  { status: "authenticated" | "offline" }
>;

interface AccessSnapshot {
  auth: ProductAccess;
  epoch: number;
}

export class AgenteraProductSpaceManagerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Aera product-space operation failed: ${code}.`);
    this.name = "AgenteraProductSpaceManagerError";
    this.code = code;
  }
}

function codedError(code: string): AgenteraProductSpaceManagerError {
  return new AgenteraProductSpaceManagerError(code);
}

function accessFingerprint(state: AgenteraAuthPublicState): string {
  switch (state.status) {
    case "authenticated":
    case "offline":
      return [state.status, state.userId, state.personalSpaceId].join("\0");
    case "unauthenticated":
      return `${state.status}\0${state.reason ?? ""}`;
    case "blocked":
      return `${state.status}\0${state.reason}`;
    case "checking":
      return state.status;
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function optionKey(option: ProductSpaceOption): string {
  switch (option.kind) {
    case "PERSONAL":
      return "0";
    case "WORKSPACE":
      return `1\0${option.displayName}\0${option.workspaceId}`;
    case "ORGANIZATION":
      return `2\0${option.displayName}\0${option.organizationId}`;
  }
}

function compareOptions(
  left: ProductSpaceOption,
  right: ProductSpaceOption,
): number {
  return compareText(optionKey(left), optionKey(right));
}

function cloneSelection(value: ProductSpaceSelection): ProductSpaceSelection {
  switch (value.kind) {
    case "PERSONAL":
      return { kind: "PERSONAL" };
    case "WORKSPACE":
      return {
        kind: "WORKSPACE",
        workspaceId: value.workspaceId,
        role: value.role,
      };
    case "ORGANIZATION":
      return {
        kind: "ORGANIZATION",
        organizationId: value.organizationId,
        role: value.role,
      };
  }
}

function cloneOption(value: ProductSpaceOption): ProductSpaceOption {
  switch (value.kind) {
    case "PERSONAL":
      return { kind: "PERSONAL" };
    case "WORKSPACE":
      return {
        kind: "WORKSPACE",
        workspaceId: value.workspaceId,
        displayName: value.displayName,
        role: value.role,
      };
    case "ORGANIZATION":
      return {
        kind: "ORGANIZATION",
        organizationId: value.organizationId,
        displayName: value.displayName,
        role: value.role,
      };
  }
}

function cloneState(value: ProductSpacePublicState): ProductSpacePublicState {
  return {
    access: value.access,
    stale: value.stale,
    selected: cloneSelection(value.selected),
    options: value.options.map(cloneOption),
  };
}

function stateKey(value: ProductSpacePublicState): string {
  return JSON.stringify(value);
}

function storedSelection(
  option: ProductSpaceOption,
): StoredProductSpaceSelection {
  switch (option.kind) {
    case "PERSONAL":
      return { kind: "PERSONAL" };
    case "WORKSPACE":
      return { kind: "WORKSPACE", workspaceId: option.workspaceId };
    case "ORGANIZATION":
      return {
        kind: "ORGANIZATION",
        organizationId: option.organizationId,
      };
  }
}

function optionSelection(option: ProductSpaceOption): ProductSpaceSelection {
  switch (option.kind) {
    case "PERSONAL":
      return { kind: "PERSONAL" };
    case "WORKSPACE":
      return {
        kind: "WORKSPACE",
        workspaceId: option.workspaceId,
        role: option.role,
      };
    case "ORGANIZATION":
      return {
        kind: "ORGANIZATION",
        organizationId: option.organizationId,
        role: option.role,
      };
  }
}

/**
 * Rebuild the option for a stored scope that a stale refresh failed to list.
 *
 * The scope keeps its identity so the user is not silently moved back to
 * Personal, but it carries the least-privileged `member` role: a degraded
 * refresh is never allowed to assert Owner, Admin, or Auditor authority.
 */
function staleSelectedOption(
  selection: StoredProductSpaceSelection,
): ProductSpaceOption | null {
  switch (selection.kind) {
    case "PERSONAL":
      return { kind: "PERSONAL" };
    case "WORKSPACE":
      return {
        kind: "WORKSPACE",
        workspaceId: selection.workspaceId,
        displayName: "",
        role: "member",
      };
    case "ORGANIZATION":
      return {
        kind: "ORGANIZATION",
        organizationId: selection.organizationId,
        displayName: "",
        role: "member",
      };
  }
}

function findStoredOption(
  selection: StoredProductSpaceSelection,
  options: readonly ProductSpaceOption[],
): ProductSpaceOption | undefined {
  return options.find((option) => {
    if (selection.kind !== option.kind) return false;
    if (selection.kind === "PERSONAL") return true;
    if (selection.kind === "WORKSPACE" && option.kind === "WORKSPACE") {
      return selection.workspaceId === option.workspaceId;
    }
    return (
      selection.kind === "ORGANIZATION" &&
      option.kind === "ORGANIZATION" &&
      selection.organizationId === option.organizationId
    );
  });
}

function findInputOption(
  input: ProductSpaceSelectionInput,
  options: readonly ProductSpaceOption[],
): ProductSpaceOption | undefined {
  return options.find((option) => {
    if (input.kind !== option.kind) return false;
    if (input.kind === "PERSONAL") return true;
    if (input.kind === "WORKSPACE" && option.kind === "WORKSPACE") {
      return input.workspaceId === option.workspaceId;
    }
    return (
      input.kind === "ORGANIZATION" &&
      option.kind === "ORGANIZATION" &&
      input.organizationId === option.organizationId
    );
  });
}

export class AgenteraProductSpaceManager {
  private readonly database: AgenteraProductSpaceDatabase;
  private readonly workspaceSource: AgenteraProductSpaceStateSource<WorkspacePublicState>;
  private readonly organizationSource: AgenteraProductSpaceStateSource<OrganizationPublicState>;
  private readonly getLegacyWorkspaceSelection: (
    accountUserId: string,
  ) => string | null;
  private readonly getAuthState: () => AgenteraAuthPublicState;
  private readonly now: () => string;
  private readonly listeners = new Set<
    (state: ProductSpacePublicState) => void
  >();
  private readonly unsubscribeSources: Array<() => void>;
  private fingerprint: string | null = null;
  private epoch = 0;
  private lastState: ProductSpacePublicState | null = null;
  private reconcileInFlight: Promise<ProductSpacePublicState> | null = null;
  private closed = false;

  constructor(options: AgenteraProductSpaceManagerOptions) {
    this.database = options.database;
    this.workspaceSource = options.workspaceSource;
    this.organizationSource = options.organizationSource;
    this.getLegacyWorkspaceSelection = options.getLegacyWorkspaceSelection;
    this.getAuthState = options.getAuthState;
    this.now = options.now ?? (() => new Date().toISOString());
    this.unsubscribeSources = [
      this.workspaceSource.subscribe(() => {
        void this.notifySourceStateChanged().catch(() => undefined);
      }),
      this.organizationSource.subscribe(() => {
        void this.notifySourceStateChanged().catch(() => undefined);
      }),
    ];
  }

  subscribe(listener: (state: ProductSpacePublicState) => void): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getState(): Promise<ProductSpacePublicState> {
    const state = await this.loadState();
    this.lastState = cloneState(state);
    return cloneState(state);
  }

  async refresh(): Promise<ProductSpacePublicState> {
    const snapshot = this.captureAccess();
    const [workspace, organization] = await Promise.all([
      this.workspaceSource.refresh(),
      this.organizationSource.refresh(),
    ]);
    const access = this.requireUnchangedAccess(snapshot);
    const state = this.reconcile(access, workspace, organization);
    this.rememberAndEmit(state);
    return cloneState(state);
  }

  async select(
    input: ProductSpaceSelectionInput,
  ): Promise<ProductSpacePublicState> {
    const snapshot = this.captureAccess();
    const current = await this.loadState();
    const access = this.requireUnchangedAccess(snapshot);
    const option = findInputOption(input, current.options);
    if (!option) throw codedError("selection_unavailable");
    const nextSelection = optionSelection(option);
    const next: ProductSpacePublicState = {
      ...current,
      selected: nextSelection,
    };
    if (stateKey(current) === stateKey(next)) {
      this.lastState = cloneState(next);
      return cloneState(next);
    }
    this.database.writeSelection(
      access.userId,
      storedSelection(option),
      this.now(),
    );
    this.rememberAndEmit(next);
    return cloneState(next);
  }

  getAgentContext(): ProductSpaceAgentContext {
    this.assertOpen();
    let access: ProductAccess;
    try {
      access = this.readAccess();
    } catch {
      return { scope: "USER" };
    }
    if (this.lastState)
      return this.contextFromSelection(this.lastState.selected);
    const stored = this.database.readSelection(access.userId);
    if (stored?.kind === "WORKSPACE") {
      return {
        scope: "WORKSPACE",
        workspaceId: stored.workspaceId,
        role: "member",
      };
    }
    // An Organization ID persisted on disk is not proof of current membership
    // or role. Reconciliation with the verified Organization source must run
    // before Organization Agent capabilities can be exposed.
    if (stored?.kind === "ORGANIZATION") return { scope: "USER" };
    return { scope: "USER" };
  }

  notifySourceStateChanged(): Promise<ProductSpacePublicState> {
    this.assertOpen();
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const promise = this.loadState().then((state) => {
      this.rememberAndEmit(state);
      return cloneState(state);
    });
    this.reconcileInFlight = promise;
    void promise.then(
      () => this.clearReconcile(promise),
      () => this.clearReconcile(promise),
    );
    return promise;
  }

  async notifyAccessStateChanged(): Promise<void> {
    try {
      await this.notifySourceStateChanged();
    } catch {
      // Unauthenticated state has no selectable product space.
    }
  }

  readSelectedWorkspaceId(accountUserId: string): string | null {
    const selected = this.database.readSelection(accountUserId);
    return selected?.kind === "WORKSPACE" ? selected.workspaceId : null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    this.reconcileInFlight = null;
    this.listeners.clear();
    for (const unsubscribe of this.unsubscribeSources) unsubscribe();
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw codedError("closed");
  }

  private readAccess(): ProductAccess {
    this.assertOpen();
    const state = this.getAuthState();
    const fingerprint = accessFingerprint(state);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.epoch += 1;
      this.lastState = null;
    }
    if (state.status !== "authenticated" && state.status !== "offline") {
      throw codedError("unauthenticated");
    }
    return state;
  }

  private captureAccess(): AccessSnapshot {
    return { auth: this.readAccess(), epoch: this.epoch };
  }

  private requireUnchangedAccess(snapshot: AccessSnapshot): ProductAccess {
    const current = this.readAccess();
    if (
      current.userId !== snapshot.auth.userId ||
      current.personalSpaceId !== snapshot.auth.personalSpaceId ||
      this.epoch !== snapshot.epoch
    ) {
      throw codedError("unauthenticated");
    }
    return current;
  }

  private async loadState(): Promise<ProductSpacePublicState> {
    const snapshot = this.captureAccess();
    const [workspace, organization] = await Promise.all([
      this.workspaceSource.getState(),
      this.organizationSource.getState(),
    ]);
    const access = this.requireUnchangedAccess(snapshot);
    return this.reconcile(access, workspace, organization);
  }

  private reconcile(
    access: ProductAccess,
    workspace: WorkspacePublicState,
    organization: OrganizationPublicState,
  ): ProductSpacePublicState {
    const activeWorkspaceIds = workspace.workspaces
      .filter(({ status }) => status === "active")
      .map(({ id }) => id);
    const workspaceOptions: ProductSpaceOption[] = workspace.workspaces
      .filter(({ status }) => status === "active")
      .map((value) => ({
        kind: "WORKSPACE",
        workspaceId: value.id,
        displayName: value.displayName,
        role: value.role,
      }));
    const organizationOptions: ProductSpaceOption[] = organization.organizations
      .filter(({ status }) => status === "active")
      .map((value) => ({
        kind: "ORGANIZATION",
        organizationId: value.id,
        displayName: value.displayName,
        role: value.role,
      }));
    const options: ProductSpaceOption[] = [
      { kind: "PERSONAL" },
      ...workspaceOptions.sort(compareOptions),
      ...organizationOptions.sort(compareOptions),
    ];

    if (
      !this.database.hasMigration(
        access.userId,
        LEGACY_WORKSPACE_SELECTION_MIGRATION,
      )
    ) {
      this.database.migrateLegacyWorkspaceSelection(access.userId, {
        legacyWorkspaceId: this.getLegacyWorkspaceSelection(access.userId),
        activeWorkspaceIds,
        completedAt: this.now(),
      });
    }
    let stored = this.database.readSelection(access.userId) ?? {
      kind: "PERSONAL" as const,
    };
    let selectedOption = findStoredOption(stored, options);
    if (!selectedOption) {
      // Only an authoritative source may retire the stored scope. A stale or
      // offline refresh can report an empty scope list while the membership is
      // still valid; dropping the selection then would silently move the user
      // back to Personal and persist that loss.
      const authoritative =
        access.status !== "offline" &&
        (stored.kind !== "WORKSPACE" || !workspace.stale) &&
        (stored.kind !== "ORGANIZATION" || !organization.stale);
      if (authoritative) {
        stored = { kind: "PERSONAL" };
        selectedOption = options[0];
        this.database.writeSelection(access.userId, stored, this.now());
      } else {
        selectedOption = staleSelectedOption(stored) ?? options[0];
      }
    }
    return {
      access: access.status === "offline" ? "offline" : "online",
      stale:
        access.status === "offline" || workspace.stale || organization.stale,
      selected: optionSelection(selectedOption),
      options: options.map(cloneOption),
    };
  }

  private contextFromSelection(
    selected: ProductSpaceSelection,
  ): ProductSpaceAgentContext {
    switch (selected.kind) {
      case "PERSONAL":
        return { scope: "USER" };
      case "WORKSPACE":
        return {
          scope: "WORKSPACE",
          workspaceId: selected.workspaceId,
          role: selected.role,
        };
      case "ORGANIZATION":
        return {
          scope: "ORGANIZATION",
          organizationId: selected.organizationId,
          role: selected.role,
        };
    }
  }

  private rememberAndEmit(state: ProductSpacePublicState): void {
    const changed =
      this.lastState === null || stateKey(this.lastState) !== stateKey(state);
    this.lastState = cloneState(state);
    if (!changed) return;
    for (const listener of this.listeners) {
      try {
        listener(cloneState(state));
      } catch {
        // A renderer listener cannot alter the trusted product-space state.
      }
    }
  }

  private clearReconcile(promise: Promise<ProductSpacePublicState>): void {
    if (this.reconcileInFlight === promise) this.reconcileInFlight = null;
  }
}
