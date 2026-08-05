import type { AgenteraRuntimeOwner } from "../agentera-profile-binding";
import type { AgentMcpRequirementV3 } from "../../shared/agentera-agent-control";
import type { AgenteraControlPlaneDatabase } from "./db";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

export type CapabilityBindingStoreErrorCode =
  | "invalid_binding"
  | "binding_conflict"
  | "installation_mismatch"
  | "profile_capability_configuration_required"
  | "binding_corrupt";

export class CapabilityBindingStoreError extends Error {
  readonly code: CapabilityBindingStoreErrorCode;

  constructor(code: CapabilityBindingStoreErrorCode) {
    super(`Aera capability binding failed: ${code}.`);
    this.name = "CapabilityBindingStoreError";
    this.code = code;
  }
}

export interface LocalCapabilityBinding {
  agentInstallationId: string;
  requirementLogicalName: string;
  localMcpName: string;
  verifiedTools: readonly string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCapabilityBindingInput {
  agentInstallationId: string;
  runtimeProfileId: string;
  requirementLogicalName: string;
  localMcpName: string;
  verifiedTools: readonly string[];
  expectedRevision: number | null;
}

export interface CapabilityBindingStoreOptions {
  database: AgenteraControlPlaneDatabase;
  owner: AgenteraRuntimeOwner;
  now?: () => Date;
}

export interface LocalMcpCapabilityServer {
  name: string;
  enabled: boolean;
  tools: string[];
}

export interface FrozenCapabilityBinding {
  logicalName: string;
  localMcpName: string;
  tools: string[];
  revision: number;
}

export interface ResolveCapabilityBindingsInput {
  agentInstallationId: string;
  runtimeProfileId: string;
  requirements: AgentMcpRequirementV3[];
  servers: LocalMcpCapabilityServer[];
}

export interface ResolvedCapabilityBindings {
  bindings: FrozenCapabilityBinding[];
  degradedRequirements: string[];
}

interface BindingRow {
  agent_installation_id?: unknown;
  requirement_logical_name?: unknown;
  local_mcp_name?: unknown;
  verified_tool_names_json?: unknown;
  revision?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function uuid(value: unknown, code: CapabilityBindingStoreErrorCode): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new CapabilityBindingStoreError(code);
  }
  return value.toLowerCase();
}

function logicalName(
  value: unknown,
  code: CapabilityBindingStoreErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    /[\0\r\n]/.test(value) ||
    value.includes("://")
  ) {
    throw new CapabilityBindingStoreError(code);
  }
  return value;
}

function localMcpName(
  value: unknown,
  code: CapabilityBindingStoreErrorCode,
): string {
  if (typeof value !== "string" || !LOCAL_MCP_NAME_PATTERN.test(value)) {
    throw new CapabilityBindingStoreError(code);
  }
  return value;
}

function verifiedTools(
  value: unknown,
  code: CapabilityBindingStoreErrorCode,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 128 ||
    !value.every(
      (tool) => typeof tool === "string" && TOOL_NAME_PATTERN.test(tool),
    )
  ) {
    throw new CapabilityBindingStoreError(code);
  }
  const result = [...value].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  if (new Set(result).size !== result.length) {
    throw new CapabilityBindingStoreError(code);
  }
  return result;
}

function liveTools(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    !value.every(
      (tool) => typeof tool === "string" && TOOL_NAME_PATTERN.test(tool),
    )
  ) {
    throw new CapabilityBindingStoreError("invalid_binding");
  }
  const result = [...value].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
  if (new Set(result).size !== result.length) {
    throw new CapabilityBindingStoreError("invalid_binding");
  }
  return result;
}

function timestamp(
  value: unknown,
  code: CapabilityBindingStoreErrorCode,
): string {
  if (typeof value !== "string") {
    throw new CapabilityBindingStoreError(code);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CapabilityBindingStoreError(code);
  }
  return value;
}

function currentTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CapabilityBindingStoreError("invalid_binding");
  }
  return value.toISOString();
}

function parseRow(row: BindingRow): LocalCapabilityBinding {
  if (
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    typeof row.verified_tool_names_json !== "string"
  ) {
    throw new CapabilityBindingStoreError("binding_corrupt");
  }
  let tools: string[];
  try {
    tools = verifiedTools(
      JSON.parse(row.verified_tool_names_json),
      "binding_corrupt",
    );
  } catch (error) {
    if (error instanceof CapabilityBindingStoreError) throw error;
    throw new CapabilityBindingStoreError("binding_corrupt");
  }
  if (JSON.stringify(tools) !== row.verified_tool_names_json) {
    throw new CapabilityBindingStoreError("binding_corrupt");
  }
  return {
    agentInstallationId: uuid(row.agent_installation_id, "binding_corrupt"),
    requirementLogicalName: logicalName(
      row.requirement_logical_name,
      "binding_corrupt",
    ),
    localMcpName: localMcpName(row.local_mcp_name, "binding_corrupt"),
    verifiedTools: tools,
    revision: row.revision as number,
    createdAt: timestamp(row.created_at, "binding_corrupt"),
    updatedAt: timestamp(row.updated_at, "binding_corrupt"),
  };
}

export class CapabilityBindingStore {
  private readonly tenantId: string;
  private readonly ownerId: string;
  private readonly deviceInstallationId: string;
  private readonly now: () => Date;

  constructor(private readonly options: CapabilityBindingStoreOptions) {
    this.tenantId = uuid(options.owner.tenantId, "invalid_binding");
    this.ownerId = uuid(options.owner.ownerId, "invalid_binding");
    this.deviceInstallationId = uuid(
      options.owner.deviceInstallationId,
      "invalid_binding",
    );
    this.now = options.now ?? (() => new Date());
  }

  upsert(input: UpsertCapabilityBindingInput): LocalCapabilityBinding {
    if (
      input === null ||
      typeof input !== "object" ||
      Object.keys(input).length !== 6 ||
      ![
        "agentInstallationId",
        "runtimeProfileId",
        "requirementLogicalName",
        "localMcpName",
        "verifiedTools",
        "expectedRevision",
      ].every((field) => Object.hasOwn(input, field)) ||
      !(
        input.expectedRevision === null ||
        (Number.isSafeInteger(input.expectedRevision) &&
          input.expectedRevision >= 1)
      )
    ) {
      throw new CapabilityBindingStoreError("invalid_binding");
    }
    const agentInstallationId = uuid(
      input.agentInstallationId,
      "invalid_binding",
    );
    const runtimeProfileId = uuid(input.runtimeProfileId, "invalid_binding");
    const requirementLogicalName = logicalName(
      input.requirementLogicalName,
      "invalid_binding",
    );
    const normalizedLocalMcpName = localMcpName(
      input.localMcpName,
      "invalid_binding",
    );
    const normalizedTools = verifiedTools(
      input.verifiedTools,
      "invalid_binding",
    );
    this.assertInstallation(agentInstallationId, runtimeProfileId);
    const now = currentTimestamp(this.now);

    this.options.database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(agentInstallationId, requirementLogicalName);
      if (
        (current === null && input.expectedRevision !== null) ||
        (current !== null && current.revision !== input.expectedRevision)
      ) {
        throw new CapabilityBindingStoreError("binding_conflict");
      }
      if (current === null) {
        this.options.database.sqlite
          .prepare(
            `INSERT INTO agent_mcp_requirement_bindings (
               tenant_id, owner_id, device_installation_id,
               agent_installation_id, requirement_logical_name,
               local_mcp_name, verified_tool_names_json, revision,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            this.tenantId,
            this.ownerId,
            this.deviceInstallationId,
            agentInstallationId,
            requirementLogicalName,
            normalizedLocalMcpName,
            JSON.stringify(normalizedTools),
            now,
            now,
          );
      } else {
        const updated = this.options.database.sqlite
          .prepare(
            `UPDATE agent_mcp_requirement_bindings
             SET local_mcp_name = ?, verified_tool_names_json = ?,
                 revision = revision + 1, updated_at = ?
             WHERE tenant_id = ? AND owner_id = ?
               AND device_installation_id = ? AND agent_installation_id = ?
               AND requirement_logical_name = ? AND revision = ?`,
          )
          .run(
            normalizedLocalMcpName,
            JSON.stringify(normalizedTools),
            now,
            this.tenantId,
            this.ownerId,
            this.deviceInstallationId,
            agentInstallationId,
            requirementLogicalName,
            current.revision,
          );
        if (Number(updated.changes) !== 1) {
          throw new CapabilityBindingStoreError("binding_conflict");
        }
      }
      const result = this.get(agentInstallationId, requirementLogicalName);
      if (result === null) {
        throw new CapabilityBindingStoreError("binding_conflict");
      }
      this.options.database.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.options.database.sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the primary validation or persistence failure.
      }
      if (error instanceof CapabilityBindingStoreError) throw error;
      throw new CapabilityBindingStoreError("binding_conflict");
    }
  }

  list(
    agentInstallationIdValue: string,
    runtimeProfileIdValue: string,
  ): LocalCapabilityBinding[] {
    const agentInstallationId = uuid(
      agentInstallationIdValue,
      "invalid_binding",
    );
    const runtimeProfileId = uuid(runtimeProfileIdValue, "invalid_binding");
    this.assertInstallation(agentInstallationId, runtimeProfileId);
    return (
      this.options.database.sqlite
        .prepare(
          `SELECT agent_installation_id, requirement_logical_name,
                  local_mcp_name, verified_tool_names_json, revision,
                  created_at, updated_at
           FROM agent_mcp_requirement_bindings
           WHERE tenant_id = ? AND owner_id = ?
             AND device_installation_id = ? AND agent_installation_id = ?
           ORDER BY requirement_logical_name`,
        )
        .all(
          this.tenantId,
          this.ownerId,
          this.deviceInstallationId,
          agentInstallationId,
        ) as BindingRow[]
    ).map(parseRow);
  }

  resolve(input: ResolveCapabilityBindingsInput): ResolvedCapabilityBindings {
    if (
      input === null ||
      typeof input !== "object" ||
      !Array.isArray(input.requirements) ||
      input.requirements.length > 32 ||
      !Array.isArray(input.servers) ||
      input.servers.length > 256
    ) {
      throw new CapabilityBindingStoreError("invalid_binding");
    }
    const stored = this.list(input.agentInstallationId, input.runtimeProfileId);
    const storedByRequirement = new Map(
      stored.map((binding) => [binding.requirementLogicalName, binding]),
    );
    const serverByName = new Map<string, LocalMcpCapabilityServer>();
    for (const server of input.servers) {
      if (
        server === null ||
        typeof server !== "object" ||
        typeof server.enabled !== "boolean"
      ) {
        throw new CapabilityBindingStoreError("invalid_binding");
      }
      const name = localMcpName(server.name, "invalid_binding");
      if (serverByName.has(name)) {
        throw new CapabilityBindingStoreError("invalid_binding");
      }
      serverByName.set(name, {
        name,
        enabled: server.enabled,
        tools: liveTools(server.tools),
      });
    }

    const bindings: FrozenCapabilityBinding[] = [];
    const degradedRequirements: string[] = [];
    for (const requirement of input.requirements) {
      const name = logicalName(requirement.logicalName, "invalid_binding");
      const requestedTools = verifiedTools(
        requirement.tools,
        "invalid_binding",
      );
      if (
        typeof requirement.required !== "boolean" ||
        typeof requirement.permissionReason !== "string"
      ) {
        throw new CapabilityBindingStoreError("invalid_binding");
      }
      const storedBinding = storedByRequirement.get(name);
      const server = storedBinding
        ? serverByName.get(storedBinding.localMcpName)
        : undefined;
      const storedToolSet = new Set(storedBinding?.verifiedTools ?? []);
      const liveToolSet = new Set(server?.tools ?? []);
      const available =
        storedBinding !== undefined &&
        server?.enabled === true &&
        requestedTools.every(
          (tool) => storedToolSet.has(tool) && liveToolSet.has(tool),
        );
      if (!available || !storedBinding) {
        if (requirement.required) {
          throw new CapabilityBindingStoreError(
            "profile_capability_configuration_required",
          );
        }
        degradedRequirements.push(name);
        continue;
      }
      bindings.push({
        logicalName: name,
        localMcpName: storedBinding.localMcpName,
        tools: requestedTools,
        revision: storedBinding.revision,
      });
    }
    return { bindings, degradedRequirements };
  }

  private get(
    agentInstallationId: string,
    requirementLogicalName: string,
  ): LocalCapabilityBinding | null {
    const row = this.options.database.sqlite
      .prepare(
        `SELECT agent_installation_id, requirement_logical_name,
                local_mcp_name, verified_tool_names_json, revision,
                created_at, updated_at
         FROM agent_mcp_requirement_bindings
         WHERE tenant_id = ? AND owner_id = ?
           AND device_installation_id = ? AND agent_installation_id = ?
           AND requirement_logical_name = ?`,
      )
      .get(
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
        agentInstallationId,
        requirementLogicalName,
      ) as BindingRow | undefined;
    return row ? parseRow(row) : null;
  }

  private assertInstallation(
    agentInstallationId: string,
    runtimeProfileId: string,
  ): void {
    const row = this.options.database.sqlite
      .prepare(
        `SELECT runtime_profile_id, status
         FROM local_agent_installations
         WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
           AND device_installation_id = ?`,
      )
      .get(
        agentInstallationId,
        this.tenantId,
        this.ownerId,
        this.deviceInstallationId,
      ) as { runtime_profile_id?: unknown; status?: unknown } | undefined;
    if (
      !row ||
      row.runtime_profile_id !== runtimeProfileId ||
      (row.status !== "pending" && row.status !== "active")
    ) {
      throw new CapabilityBindingStoreError("installation_mismatch");
    }
  }
}
