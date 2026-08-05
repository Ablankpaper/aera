import { randomUUID as nodeRandomUUID } from "node:crypto";
import type {
  AgentCapabilityBindingConfiguration,
  ConfirmCapabilityBindingsInput,
} from "../../shared/agentera-agent-control";
import type {
  CapabilityBindingStore,
  LocalCapabilityBinding,
  LocalMcpCapabilityServer,
} from "./capability-binding-store";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HANDLE_TTL_MS = 5 * 60 * 1000;

export type CapabilityBindingServiceErrorCode =
  | "invalid_binding"
  | "binding_conflict"
  | "profile_capability_configuration_required";

export class CapabilityBindingServiceError extends Error {
  readonly code: CapabilityBindingServiceErrorCode;

  constructor(code: CapabilityBindingServiceErrorCode) {
    super(`Aera capability binding service failed: ${code}.`);
    this.name = "CapabilityBindingServiceError";
    this.code = code;
  }
}

export interface CapabilityBindingInstallation {
  agentInstallationId: string;
  selectedVersionId: string;
  runtimeProfileId: string | null;
  status: "pending" | "active" | "archived";
  retryCode: string | null;
}

interface CapabilityBindingVersion {
  id: string;
  manifest:
    | { schema_version: 1 | 2 }
    | {
        schema_version: 3;
        mcp_requirements: readonly {
          logical_name: string;
          tools: readonly string[];
          required: boolean;
          permission_reason: string;
        }[];
      };
}

interface CapabilityBindingStoreAdapter {
  list(
    agentInstallationId: string,
    runtimeProfileId: string,
  ): LocalCapabilityBinding[];
  upsert: CapabilityBindingStore["upsert"];
}

export interface CapabilityBindingServiceOptions<
  TInstallation extends CapabilityBindingInstallation =
    CapabilityBindingInstallation,
> {
  getOwnerKey: () => string;
  getInstallation: (installationId: string) => TInstallation;
  getVerifiedVersion: (versionId: string) => CapabilityBindingVersion;
  resolveProfilePath: (
    runtimeProfileId: string,
    installationId: string,
  ) => string;
  listCapabilityServers: (
    profilePath: string,
  ) => LocalMcpCapabilityServer[] | Promise<LocalMcpCapabilityServer[]>;
  bindingStore: CapabilityBindingStoreAdapter;
  resumePendingInstallation: (
    installationId: string,
  ) => TInstallation | Promise<TInstallation>;
  now?: () => Date;
  randomUUID?: () => string;
}

interface PreparedCapabilityMapping {
  handle: string;
  ownerKey: string;
  installationId: string;
  versionId: string;
  runtimeProfileId: string;
  requirementLogicalName: string;
  requestedTools: string[];
  localMcpName: string;
  expectedRevision: number | null;
  expiresAtMs: number;
}

function invalidBinding(): never {
  throw new CapabilityBindingServiceError("invalid_binding");
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return invalidBinding();
  }
  return value.toLowerCase();
}

function ownerKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\r\n]/.test(value)
  ) {
    return invalidBinding();
  }
  return value;
}

function safeLocalMcpName(value: unknown): string {
  if (typeof value !== "string" || !LOCAL_MCP_NAME_PATTERN.test(value)) {
    return invalidBinding();
  }
  return value;
}

function safeTools(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 128 ||
    !value.every(
      (tool) =>
        typeof tool === "string" &&
        /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(tool),
    )
  ) {
    return invalidBinding();
  }
  const result = [...value].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  if (new Set(result).size !== result.length) return invalidBinding();
  return result;
}

function safeLiveTools(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) return invalidBinding();
  if (value.length === 0) return [];
  return safeTools(value);
}

function currentTime(now: () => Date): number {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return invalidBinding();
  }
  return value.getTime();
}

function compatible(
  requestedTools: readonly string[],
  server: LocalMcpCapabilityServer,
): boolean {
  if (!server.enabled) return false;
  const available = new Set(safeLiveTools(server.tools));
  return requestedTools.every((tool) => available.has(tool));
}

export class CapabilityBindingService<
  TInstallation extends CapabilityBindingInstallation =
    CapabilityBindingInstallation,
> {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly prepared = new Map<string, PreparedCapabilityMapping>();

  constructor(
    private readonly options: CapabilityBindingServiceOptions<TInstallation>,
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  async list(
    installationIdValue: string,
  ): Promise<AgentCapabilityBindingConfiguration> {
    const owner = ownerKey(this.options.getOwnerKey());
    const installationId = uuid(installationIdValue);
    const installation = this.options.getInstallation(installationId);
    const runtimeProfileId = this.assertInstallation(
      installation,
      installationId,
    );
    const version = this.options.getVerifiedVersion(
      uuid(installation.selectedVersionId),
    );
    if (uuid(version.id) !== uuid(installation.selectedVersionId)) {
      return invalidBinding();
    }
    const requirements =
      version.manifest.schema_version === 3
        ? version.manifest.mcp_requirements
        : [];
    if (!Array.isArray(requirements) || requirements.length > 32) {
      return invalidBinding();
    }
    const profilePath = this.options.resolveProfilePath(
      runtimeProfileId,
      installationId,
    );
    if (typeof profilePath !== "string" || profilePath.length < 1) {
      return invalidBinding();
    }
    const servers = await this.options.listCapabilityServers(profilePath);
    if (!Array.isArray(servers) || servers.length > 256) {
      return invalidBinding();
    }
    const normalizedServers = servers.map((server) => ({
      name: safeLocalMcpName(server.name),
      enabled: server.enabled === true,
      tools: safeLiveTools(server.tools),
    }));
    if (
      new Set(normalizedServers.map((server) => server.name)).size !==
      normalizedServers.length
    ) {
      return invalidBinding();
    }
    const bindings = this.options.bindingStore.list(
      installationId,
      runtimeProfileId,
    );
    const bindingByRequirement = new Map(
      bindings.map((binding) => [binding.requirementLogicalName, binding]),
    );
    this.invalidateInstallation(owner, installationId);
    const nowMs = currentTime(this.now);

    return {
      installationId,
      requirements: requirements.map((requirement) => {
        const logicalName = requirement.logical_name;
        if (
          typeof logicalName !== "string" ||
          logicalName.length < 1 ||
          logicalName.length > 128 ||
          typeof requirement.required !== "boolean" ||
          typeof requirement.permission_reason !== "string" ||
          requirement.permission_reason.length < 1 ||
          requirement.permission_reason.length > 300
        ) {
          return invalidBinding();
        }
        const tools = safeTools(requirement.tools);
        const currentBinding = bindingByRequirement.get(logicalName) ?? null;
        return {
          logicalName,
          tools,
          required: requirement.required,
          permissionReason: requirement.permission_reason,
          mappedLocalMcpName: currentBinding?.localMcpName ?? null,
          compatibleServers: normalizedServers
            .filter((server) => compatible(tools, server))
            .map((server) => {
              const handle = this.createHandle({
                ownerKey: owner,
                installationId,
                versionId: version.id,
                runtimeProfileId,
                requirementLogicalName: logicalName,
                requestedTools: tools,
                localMcpName: server.name,
                expectedRevision: currentBinding?.revision ?? null,
                expiresAtMs: nowMs + HANDLE_TTL_MS,
              });
              const verified = new Set(currentBinding?.verifiedTools ?? []);
              return {
                mappingHandle: handle,
                displayName: server.name,
                current:
                  currentBinding?.localMcpName === server.name &&
                  tools.every((tool) => verified.has(tool)),
              };
            }),
        };
      }),
    };
  }

  async confirm(input: ConfirmCapabilityBindingsInput): Promise<{
    installation: TInstallation;
    forceNewConversation: true;
  }> {
    if (
      input === null ||
      typeof input !== "object" ||
      input.confirmation !== "bind-profile-capabilities" ||
      !Array.isArray(input.mappingHandles) ||
      input.mappingHandles.length > 32 ||
      new Set(input.mappingHandles).size !== input.mappingHandles.length
    ) {
      return invalidBinding();
    }
    const owner = ownerKey(this.options.getOwnerKey());
    const installationId = uuid(input.installationId);
    const installation = this.options.getInstallation(installationId);
    const runtimeProfileId = this.assertInstallation(
      installation,
      installationId,
    );
    const version = this.options.getVerifiedVersion(
      uuid(installation.selectedVersionId),
    );
    if (
      uuid(version.id) !== uuid(installation.selectedVersionId) ||
      version.manifest.schema_version !== 3
    ) {
      return invalidBinding();
    }
    const requirements = version.manifest.mcp_requirements;
    const requirementByName = new Map(
      requirements.map((requirement) => [
        requirement.logical_name,
        requirement,
      ]),
    );
    if (requirementByName.size !== requirements.length) return invalidBinding();

    const nowMs = currentTime(this.now);
    const selected: PreparedCapabilityMapping[] = [];
    for (const handleValue of input.mappingHandles) {
      const handle = uuid(handleValue);
      const prepared = this.prepared.get(handle);
      this.prepared.delete(handle);
      if (
        !prepared ||
        prepared.ownerKey !== owner ||
        prepared.installationId !== installationId ||
        prepared.versionId !== version.id ||
        prepared.runtimeProfileId !== runtimeProfileId ||
        prepared.expiresAtMs < nowMs
      ) {
        return invalidBinding();
      }
      selected.push(prepared);
    }
    if (
      new Set(selected.map((mapping) => mapping.requirementLogicalName))
        .size !== selected.length
    ) {
      return invalidBinding();
    }
    const selectedByRequirement = new Map(
      selected.map((mapping) => [mapping.requirementLogicalName, mapping]),
    );
    for (const requirement of requirements) {
      if (
        requirement.required &&
        !selectedByRequirement.has(requirement.logical_name)
      ) {
        throw new CapabilityBindingServiceError(
          "profile_capability_configuration_required",
        );
      }
    }

    const profilePath = this.options.resolveProfilePath(
      runtimeProfileId,
      installationId,
    );
    const liveServers = await this.options.listCapabilityServers(profilePath);
    const liveByName = new Map(
      liveServers.map((server) => [safeLocalMcpName(server.name), server]),
    );
    const currentBindings = new Map(
      this.options.bindingStore
        .list(installationId, runtimeProfileId)
        .map((binding) => [binding.requirementLogicalName, binding]),
    );
    for (const mapping of selected) {
      const requirement = requirementByName.get(mapping.requirementLogicalName);
      const server = liveByName.get(mapping.localMcpName);
      const current = currentBindings.get(mapping.requirementLogicalName);
      if (
        !requirement ||
        !server ||
        !compatible(mapping.requestedTools, server) ||
        JSON.stringify(safeTools(requirement.tools)) !==
          JSON.stringify(mapping.requestedTools) ||
        (current?.revision ?? null) !== mapping.expectedRevision
      ) {
        throw new CapabilityBindingServiceError("binding_conflict");
      }
    }

    this.invalidateInstallation(owner, installationId);
    for (const mapping of selected) {
      this.options.bindingStore.upsert({
        agentInstallationId: installationId,
        runtimeProfileId,
        requirementLogicalName: mapping.requirementLogicalName,
        localMcpName: mapping.localMcpName,
        verifiedTools: mapping.requestedTools,
        expectedRevision: mapping.expectedRevision,
      });
    }
    const completed =
      installation.status === "pending"
        ? await this.options.resumePendingInstallation(installationId)
        : this.options.getInstallation(installationId);
    if (completed.status !== "active") {
      throw new CapabilityBindingServiceError(
        "profile_capability_configuration_required",
      );
    }
    return { installation: completed, forceNewConversation: true };
  }

  invalidate(): void {
    this.prepared.clear();
  }

  private assertInstallation(
    installation: CapabilityBindingInstallation,
    installationId: string,
  ): string {
    if (
      installation.agentInstallationId !== installationId ||
      installation.status === "archived" ||
      (installation.status === "pending" &&
        installation.retryCode !==
          "profile_capability_configuration_required") ||
      installation.runtimeProfileId === null
    ) {
      return invalidBinding();
    }
    return uuid(installation.runtimeProfileId);
  }

  private createHandle(
    value: Omit<PreparedCapabilityMapping, "handle">,
  ): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const handle = uuid(this.randomUUID());
      if (this.prepared.has(handle)) continue;
      this.prepared.set(handle, { handle, ...value });
      return handle;
    }
    return invalidBinding();
  }

  private invalidateInstallation(owner: string, installationId: string): void {
    for (const [handle, prepared] of this.prepared) {
      if (
        prepared.ownerKey === owner &&
        prepared.installationId === installationId
      ) {
        this.prepared.delete(handle);
      }
    }
  }
}
