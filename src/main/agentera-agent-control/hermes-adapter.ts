import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentPolicySnapshot, AgentVersion } from "./client";
import type { AgenteraControlPlaneDatabase } from "./db";
import type { HermesVersionProjection } from "./hermes-projection";
import {
  RuntimeBindingStoreError,
  type CreateLocalRuntimeBindingInput,
  type LocalRuntimeBinding,
  type RuntimeBindingStore,
} from "./runtime-binding-store";
import type {
  AgenteraRuntimeOwner,
  RuntimeOwnerBinding,
} from "../agentera-profile-binding";
import type { HermesConversationEnvelope } from "../hermes";
import type { AgenteraAgentControlContext } from "../../shared/agentera-agent-control";
import type { SessionModelOverride } from "../../shared/model-override";
import {
  agentModelPolicyAllowsRoute,
  modelPolicyForManifest,
  modelPolicyForPolicyDocument,
} from "./model-policy";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type AgenteraHermesAdapterErrorCode =
  | "local_runtime_required"
  | "entitlement_required"
  | "profile_binding_invalid"
  | "installation_invalid"
  | "organization_agent_forbidden"
  | "binding_required"
  | "binding_conflict"
  | "version_invalid"
  | "policy_invalid"
  | "runtime_drift"
  | "tool_policy_drift"
  | "model_policy_drift"
  | "version_revoked"
  | "projection_invalid";

export class AgenteraHermesAdapterError extends Error {
  readonly code: AgenteraHermesAdapterErrorCode;

  constructor(code: AgenteraHermesAdapterErrorCode) {
    super(`Aera Runtime adapter failed: ${code}.`);
    this.name = "AgenteraHermesAdapterError";
    this.code = code;
  }
}

export interface AgenteraHermesProfileBindings {
  verifyProfileBinding(
    profilePath: string,
    owner: AgenteraRuntimeOwner,
  ): RuntimeOwnerBinding;
}

export interface AgenteraHermesVerifiedCache {
  getVerifiedVersion(versionId: string): AgentVersion;
  getVerifiedPolicySnapshot(
    versionId: string,
    policyId: string,
  ): AgentPolicySnapshot;
}

export interface AgenteraHermesProjection {
  materializeVersion(input: {
    agentInstallationId: string;
    version: AgentVersion;
  }): HermesVersionProjection;
}

export interface AgenteraHermesAdapterOptions {
  database: AgenteraControlPlaneDatabase;
  bindingStore: RuntimeBindingStore;
  profileBindings: AgenteraHermesProfileBindings;
  cache: AgenteraHermesVerifiedCache;
  projection: AgenteraHermesProjection;
  getConnectionMode: () => "local" | "remote" | "ssh";
  getRuntimeVersion: () => string | Promise<string>;
  getCurrentToolPermissionDigest?: (
    version: AgentVersion,
    policy: AgentPolicySnapshot,
  ) => string | Promise<string>;
  getProfileModelConfig: (profilePath: string) => SessionModelOverride;
  isVersionRevoked: (versionId: string) => boolean | Promise<boolean>;
  assertEntitled: () => void | Promise<void>;
  getAgentContext: () => AgenteraAgentControlContext;
}

export interface PrepareInstalledHermesTurnInput {
  conversationKey: string;
  profilePath: string;
  owner: AgenteraRuntimeOwner;
  resumeSessionId: string | null;
}

export interface PreparedInstalledHermesTurn {
  binding: LocalRuntimeBinding;
  profilePath: string;
  resumeSessionId: string | undefined;
  envelope: HermesConversationEnvelope;
  modelOverride: SessionModelOverride;
}

export interface PreparedInstalledHermesTurnPlan {
  bindingInput: CreateLocalRuntimeBindingInput;
  profilePath: string;
  modelOverride: SessionModelOverride;
  version: AgentVersion;
  policy: AgentPolicySnapshot;
  projection: HermesVersionProjection;
}

interface LocalInstallationRow {
  agent_installation_id?: unknown;
  source_scope?: unknown;
  source_workspace_id?: unknown;
  source_organization_id?: unknown;
  official_release_id?: unknown;
  selected_release_revision_id?: unknown;
  update_policy?: unknown;
  definition_id?: unknown;
  selected_version_id?: unknown;
  runtime_profile_id?: unknown;
  policy_snapshot_id?: unknown;
  status?: unknown;
}

interface LocalInstallation {
  agentInstallationId: string;
  sourceScope: "USER" | "WORKSPACE" | "ORGANIZATION" | "PLATFORM";
  sourceWorkspaceId: string | null;
  sourceOrganizationId: string | null;
  officialReleaseId: string | null;
  selectedReleaseRevisionId: string | null;
  definitionId: string;
  selectedVersionId: string;
  runtimeProfileId: string;
  policySnapshotId: string;
  status: "active";
}

function uuid(value: unknown, code: AgenteraHermesAdapterErrorCode): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AgenteraHermesAdapterError(code);
  }
  return value.toLowerCase();
}

function digest(value: unknown, code: AgenteraHermesAdapterErrorCode): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new AgenteraHermesAdapterError(code);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Digest only published/effective tool declarations. No Profile-local Skill,
 * credential, session, Memory, USER, or adaptive-state bytes participate.
 */
export function digestToolPermissionDeclaration(
  version: AgentVersion,
  policy: AgentPolicySnapshot,
): string {
  return createHash("sha256")
    .update(
      stableJson({
        published: version.manifest.tools,
        effective: policy.document.tools,
        denyRules: policy.document.deny_rules,
      }),
      "utf8",
    )
    .digest("hex");
}

function parseInstallation(
  row: LocalInstallationRow | undefined,
): LocalInstallation {
  if (
    !row ||
    row.status !== "active" ||
    row.runtime_profile_id === null ||
    row.policy_snapshot_id === null
  ) {
    throw new AgenteraHermesAdapterError("installation_invalid");
  }
  const sourceWorkspaceId =
    row.source_workspace_id === null
      ? null
      : uuid(row.source_workspace_id, "installation_invalid");
  const sourceOrganizationId =
    row.source_organization_id === null
      ? null
      : uuid(row.source_organization_id, "installation_invalid");
  const officialReleaseId =
    row.official_release_id === null
      ? null
      : uuid(row.official_release_id, "installation_invalid");
  const selectedReleaseRevisionId =
    row.selected_release_revision_id === null
      ? null
      : uuid(row.selected_release_revision_id, "installation_invalid");
  if (
    (row.source_scope === "USER" &&
      (sourceWorkspaceId !== null ||
        sourceOrganizationId !== null ||
        officialReleaseId !== null ||
        selectedReleaseRevisionId !== null ||
        row.update_policy !== "manual")) ||
    (row.source_scope === "WORKSPACE" &&
      (sourceWorkspaceId === null ||
        sourceOrganizationId !== null ||
        officialReleaseId !== null ||
        selectedReleaseRevisionId !== null ||
        row.update_policy !== "manual")) ||
    (row.source_scope === "ORGANIZATION" &&
      (sourceWorkspaceId !== null ||
        sourceOrganizationId === null ||
        officialReleaseId !== null ||
        selectedReleaseRevisionId !== null ||
        row.update_policy !== "manual")) ||
    (row.source_scope === "PLATFORM" &&
      (sourceWorkspaceId !== null ||
        sourceOrganizationId !== null ||
        officialReleaseId === null ||
        selectedReleaseRevisionId === null ||
        row.update_policy !== "managed")) ||
    (row.source_scope !== "USER" &&
      row.source_scope !== "WORKSPACE" &&
      row.source_scope !== "ORGANIZATION" &&
      row.source_scope !== "PLATFORM")
  ) {
    throw new AgenteraHermesAdapterError("installation_invalid");
  }
  return {
    agentInstallationId: uuid(
      row.agent_installation_id,
      "installation_invalid",
    ),
    sourceScope: row.source_scope,
    sourceWorkspaceId,
    sourceOrganizationId,
    officialReleaseId,
    selectedReleaseRevisionId,
    definitionId: uuid(row.definition_id, "installation_invalid"),
    selectedVersionId: uuid(row.selected_version_id, "installation_invalid"),
    runtimeProfileId: uuid(row.runtime_profile_id, "installation_invalid"),
    policySnapshotId: uuid(row.policy_snapshot_id, "installation_invalid"),
    status: "active",
  };
}

function assertNewConversationContext(
  installation: LocalInstallation,
  context: AgenteraAgentControlContext,
): void {
  if (installation.sourceScope !== "ORGANIZATION") return;
  if (
    context.scope !== "ORGANIZATION" ||
    context.organizationId.toLowerCase() !==
      installation.sourceOrganizationId ||
    (context.role !== "owner" &&
      context.role !== "admin" &&
      context.role !== "member")
  ) {
    throw new AgenteraHermesAdapterError("organization_agent_forbidden");
  }
}

function assertOwnerAndProfileBinding(
  binding: RuntimeOwnerBinding,
  owner: AgenteraRuntimeOwner,
): void {
  if (
    binding.ownerScope !== "USER" ||
    binding.tenantId !== uuid(owner.tenantId, "profile_binding_invalid") ||
    binding.ownerId !== uuid(owner.ownerId, "profile_binding_invalid") ||
    binding.deviceInstallationId !==
      uuid(owner.deviceInstallationId, "profile_binding_invalid") ||
    binding.agentInstallationId === null
  ) {
    throw new AgenteraHermesAdapterError("profile_binding_invalid");
  }
}

function assertExistingBinding(
  binding: LocalRuntimeBinding,
  owner: AgenteraRuntimeOwner,
  profile: RuntimeOwnerBinding,
): void {
  if (
    binding.tenantId !== owner.tenantId.toLowerCase() ||
    binding.ownerId !== owner.ownerId.toLowerCase() ||
    binding.deviceId !== owner.deviceInstallationId.toLowerCase() ||
    binding.ownerScope !== "USER" ||
    binding.agentInstallationId !== profile.agentInstallationId ||
    binding.runtimeProfileId !== profile.runtimeProfileId
  ) {
    throw new AgenteraHermesAdapterError("binding_conflict");
  }
}

function assertVersion(
  version: AgentVersion,
  expectedVersionId: string,
  expectedDefinitionId: string,
  expectedDigest?: string,
): void {
  if (
    uuid(version.id, "version_invalid") !== expectedVersionId ||
    uuid(version.definition_id, "version_invalid") !== expectedDefinitionId ||
    (expectedDigest !== undefined &&
      digest(version.content_digest, "version_invalid") !== expectedDigest)
  ) {
    throw new AgenteraHermesAdapterError("version_invalid");
  }
  digest(version.content_digest, "version_invalid");
}

function assertPolicy(
  policy: AgentPolicySnapshot,
  input: {
    policyId: string;
    installationId: string;
    versionId: string;
    definitionId: string;
    versionDigest: string;
    officialReleaseId: string | null;
    officialReleaseRevisionId: string | null;
    owner: AgenteraRuntimeOwner;
  },
): void {
  const official = policy.document.official_context;
  if (
    uuid(policy.id, "policy_invalid") !== input.policyId ||
    uuid(policy.installation_id, "policy_invalid") !== input.installationId ||
    uuid(policy.agent_version_id, "policy_invalid") !== input.versionId ||
    uuid(policy.document.agent_definition_id, "policy_invalid") !==
      input.definitionId ||
    uuid(policy.document.agent_version_id, "policy_invalid") !==
      input.versionId ||
    digest(policy.document.version_digest, "policy_invalid") !==
      input.versionDigest ||
    (input.officialReleaseRevisionId === null
      ? official !== undefined || input.officialReleaseId !== null
      : official === undefined ||
        input.officialReleaseId === null ||
        uuid(official.release_id, "policy_invalid") !==
          input.officialReleaseId ||
        uuid(official.release_revision_id, "policy_invalid") !==
          input.officialReleaseRevisionId ||
        uuid(official.user_id, "policy_invalid") !==
          input.owner.ownerId.toLowerCase() ||
        uuid(official.device_installation_id, "policy_invalid") !==
          input.owner.deviceInstallationId.toLowerCase() ||
        uuid(official.installation_id, "policy_invalid") !==
          input.installationId ||
        official.product_scope !== "USER" ||
        uuid(official.product_context_id, "policy_invalid") !==
          input.owner.tenantId.toLowerCase())
  ) {
    throw new AgenteraHermesAdapterError("policy_invalid");
  }
  digest(policy.content_digest, "policy_invalid");
}

function composePublishedInstructions(input: {
  binding: LocalRuntimeBinding;
  version: AgentVersion;
  policy: AgentPolicySnapshot;
  projection: HermesVersionProjection;
}): string {
  const { binding, version, policy, projection } = input;
  if (
    projection.agentInstallationId !== binding.agentInstallationId ||
    projection.definitionId !== binding.agentDefinitionId ||
    projection.versionId !== binding.agentVersionId ||
    projection.contentDigest !== binding.publishedBaseDigest
  ) {
    throw new AgenteraHermesAdapterError("projection_invalid");
  }
  const assets = version.manifest.assets
    .map((asset) => ({
      kind: asset.kind,
      path: join(projection.versionRoot, "assets", ...asset.path.split("/")),
      sha256: asset.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const skills = [...projection.skills]
    .map((skill) => ({
      name: skill.scopedName,
      path: join(projection.versionRoot, "skills", skill.scopedName),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return [
    "Aera installed Agent published base (immutable for this conversation).",
    version.manifest.identity.system_prompt,
    `Version identity: definition=${binding.agentDefinitionId}; version=${binding.agentVersionId}; version_number=${version.version_number}; digest=${binding.publishedBaseDigest}.`,
    `Policy snapshot: id=${binding.policySnapshotId}; digest=${policy.content_digest}; tool_permission_digest=${binding.toolPermissionDigest}.`,
    `Published version-scoped Skills (read-only): ${stableJson(skills)}.`,
    `Published assets (read-only): ${stableJson(assets)}.`,
    `Effective policy constraints: ${stableJson({
      model: modelPolicyForPolicyDocument(policy.document),
      runtime: policy.document.runtime_compatibility,
      tools: policy.document.tools,
      denyRules: policy.document.deny_rules,
      publicationAllowed: policy.document.publication_allowed,
    })}.`,
    "Profile-local SOUL and Skills take precedence when they conflict with this published base.",
    "Aera Runtime remains the sole execution and adaptive-learning engine; keep all local adaptive state private and do not treat it as part of this published base.",
  ].join("\n\n");
}

export class AgenteraHermesAdapter {
  private readonly options: AgenteraHermesAdapterOptions;

  constructor(options: AgenteraHermesAdapterOptions) {
    this.options = options;
  }

  async prepareInstalledTurn(
    input: PrepareInstalledHermesTurnInput,
  ): Promise<PreparedInstalledHermesTurn> {
    const plan = await this.prepareInstalledTurnPlan(input);
    const binding = this.options.bindingStore.getOrCreateForConversation(
      plan.bindingInput,
    );
    return this.finalizeInstalledTurn(plan, binding);
  }

  async prepareInstalledTurnPlan(
    input: PrepareInstalledHermesTurnInput,
  ): Promise<PreparedInstalledHermesTurnPlan> {
    if (this.options.getConnectionMode() !== "local") {
      throw new AgenteraHermesAdapterError("local_runtime_required");
    }
    try {
      await this.options.assertEntitled();
    } catch {
      throw new AgenteraHermesAdapterError("entitlement_required");
    }

    let profile: RuntimeOwnerBinding;
    try {
      profile = this.options.profileBindings.verifyProfileBinding(
        input.profilePath,
        input.owner,
      );
      assertOwnerAndProfileBinding(profile, input.owner);
    } catch (error) {
      if (error instanceof AgenteraHermesAdapterError) throw error;
      throw new AgenteraHermesAdapterError("profile_binding_invalid");
    }

    const installation = parseInstallation(
      this.options.database.sqlite
        .prepare(
          `SELECT agent_installation_id, definition_id, selected_version_id,
                  source_scope, source_workspace_id, source_organization_id,
                  official_release_id, selected_release_revision_id,
                  update_policy, runtime_profile_id, policy_snapshot_id, status
           FROM local_agent_installations
           WHERE agent_installation_id = ? AND tenant_id = ? AND owner_id = ?
             AND device_installation_id = ?`,
        )
        .get(
          profile.agentInstallationId,
          input.owner.tenantId,
          input.owner.ownerId,
          input.owner.deviceInstallationId,
        ) as LocalInstallationRow | undefined,
    );
    if (
      installation.agentInstallationId !== profile.agentInstallationId ||
      installation.runtimeProfileId !== profile.runtimeProfileId
    ) {
      throw new AgenteraHermesAdapterError("installation_invalid");
    }

    let existing: LocalRuntimeBinding | null;
    try {
      existing = input.resumeSessionId
        ? this.options.bindingStore.resolveInstalledResume(
            input.conversationKey,
            input.resumeSessionId,
          )
        : this.options.bindingStore.getByConversationKey(input.conversationKey);
    } catch (error) {
      if (
        error instanceof RuntimeBindingStoreError &&
        error.code === "binding_required"
      ) {
        throw new AgenteraHermesAdapterError("binding_required");
      }
      throw new AgenteraHermesAdapterError("binding_conflict");
    }
    if (existing) assertExistingBinding(existing, input.owner, profile);
    if (
      existing &&
      ((installation.sourceScope === "PLATFORM" &&
        existing.officialReleaseRevisionId === null) ||
        (installation.sourceScope !== "PLATFORM" &&
          existing.officialReleaseRevisionId !== null))
    ) {
      throw new AgenteraHermesAdapterError("binding_conflict");
    }
    if (!existing) {
      assertNewConversationContext(
        installation,
        this.options.getAgentContext(),
      );
    }

    const definitionId =
      existing?.agentDefinitionId ?? installation.definitionId;
    const versionId =
      existing?.agentVersionId ?? installation.selectedVersionId;
    const policyId =
      existing?.policySnapshotId ?? installation.policySnapshotId;
    let version: AgentVersion;
    try {
      version = this.options.cache.getVerifiedVersion(versionId);
      assertVersion(
        version,
        versionId,
        definitionId,
        existing?.publishedBaseDigest,
      );
    } catch (error) {
      if (error instanceof AgenteraHermesAdapterError) throw error;
      throw new AgenteraHermesAdapterError("version_invalid");
    }
    let policy: AgentPolicySnapshot;
    try {
      policy = this.options.cache.getVerifiedPolicySnapshot(
        versionId,
        policyId,
      );
      assertPolicy(policy, {
        policyId,
        installationId: installation.agentInstallationId,
        versionId,
        definitionId,
        versionDigest: version.content_digest,
        officialReleaseId: installation.officialReleaseId,
        officialReleaseRevisionId:
          existing?.officialReleaseRevisionId ??
          installation.selectedReleaseRevisionId,
        owner: input.owner,
      });
    } catch (error) {
      if (error instanceof AgenteraHermesAdapterError) throw error;
      throw new AgenteraHermesAdapterError("policy_invalid");
    }

    if (await this.options.isVersionRevoked(versionId)) {
      throw new AgenteraHermesAdapterError("version_revoked");
    }
    const runtimeVersion = await this.options.getRuntimeVersion();
    if (
      typeof runtimeVersion !== "string" ||
      runtimeVersion.length === 0 ||
      runtimeVersion.length > 128 ||
      (existing !== null && runtimeVersion !== existing.runtimeVersion)
    ) {
      throw new AgenteraHermesAdapterError("runtime_drift");
    }
    const expectedToolDigest = digestToolPermissionDeclaration(version, policy);
    const currentToolDigest = digest(
      await (this.options.getCurrentToolPermissionDigest?.(version, policy) ??
        expectedToolDigest),
      "tool_policy_drift",
    );
    if (
      currentToolDigest !== expectedToolDigest ||
      (existing !== null && currentToolDigest !== existing.toolPermissionDigest)
    ) {
      throw new AgenteraHermesAdapterError("tool_policy_drift");
    }

    let currentModelRoute: SessionModelOverride;
    try {
      currentModelRoute = this.options.getProfileModelConfig(input.profilePath);
    } catch {
      throw new AgenteraHermesAdapterError("model_policy_drift");
    }
    const selectedModelRoute = existing?.modelRoute ?? currentModelRoute;
    if (
      !agentModelPolicyAllowsRoute(
        modelPolicyForManifest(version.manifest),
        selectedModelRoute.provider,
        selectedModelRoute.model,
      ) ||
      !agentModelPolicyAllowsRoute(
        modelPolicyForPolicyDocument(policy.document),
        selectedModelRoute.provider,
        selectedModelRoute.model,
      )
    ) {
      throw new AgenteraHermesAdapterError("model_policy_drift");
    }

    let projection: HermesVersionProjection;
    try {
      projection = this.options.projection.materializeVersion({
        agentInstallationId: installation.agentInstallationId,
        version,
      });
    } catch {
      throw new AgenteraHermesAdapterError("projection_invalid");
    }

    const bindingInput: CreateLocalRuntimeBindingInput = {
      conversationKey: existing?.conversationKey ?? input.conversationKey,
      tenantId: input.owner.tenantId,
      ownerScope: "USER",
      ownerId: input.owner.ownerId,
      deviceId: input.owner.deviceInstallationId,
      agentDefinitionId: definitionId,
      agentVersionId: versionId,
      agentInstallationId: installation.agentInstallationId,
      runtimeProfileId: installation.runtimeProfileId,
      runtimeVersion,
      modelRoute: selectedModelRoute,
      policySnapshotId: policyId,
      officialReleaseRevisionId:
        existing?.officialReleaseRevisionId ??
        installation.selectedReleaseRevisionId,
      toolPermissionDigest: currentToolDigest,
      publishedBaseDigest: version.content_digest,
    };
    return {
      bindingInput,
      profilePath: input.profilePath,
      modelOverride: selectedModelRoute,
      version,
      policy,
      projection,
    };
  }

  finalizeInstalledTurn(
    plan: PreparedInstalledHermesTurnPlan,
    binding: LocalRuntimeBinding,
  ): PreparedInstalledHermesTurn {
    if (
      binding.conversationKey !== plan.bindingInput.conversationKey ||
      binding.tenantId !== plan.bindingInput.tenantId ||
      binding.ownerScope !== plan.bindingInput.ownerScope ||
      binding.ownerId !== plan.bindingInput.ownerId ||
      binding.deviceId !== plan.bindingInput.deviceId ||
      binding.agentDefinitionId !== plan.bindingInput.agentDefinitionId ||
      binding.agentVersionId !== plan.bindingInput.agentVersionId ||
      binding.agentInstallationId !== plan.bindingInput.agentInstallationId ||
      binding.runtimeProfileId !== plan.bindingInput.runtimeProfileId ||
      binding.runtimeVersion !== plan.bindingInput.runtimeVersion ||
      (binding.modelRoute !== null &&
        JSON.stringify(binding.modelRoute) !==
          JSON.stringify(plan.bindingInput.modelRoute)) ||
      binding.policySnapshotId !== plan.bindingInput.policySnapshotId ||
      binding.officialReleaseRevisionId !==
        plan.bindingInput.officialReleaseRevisionId ||
      binding.toolPermissionDigest !== plan.bindingInput.toolPermissionDigest ||
      binding.publishedBaseDigest !== plan.bindingInput.publishedBaseDigest
    ) {
      throw new AgenteraHermesAdapterError("binding_conflict");
    }
    const instructions = composePublishedInstructions({
      binding,
      version: plan.version,
      policy: plan.policy,
      projection: plan.projection,
    });
    return {
      binding,
      profilePath: plan.profilePath,
      resumeSessionId: binding.hermesSessionId ?? undefined,
      envelope: { instructions, requireBoundApiTransport: true },
      modelOverride: plan.modelOverride,
    };
  }

  attachHermesSession(
    bindingId: string,
    hermesSessionId: string,
  ): LocalRuntimeBinding {
    return this.options.bindingStore.attachHermesSession(
      bindingId,
      hermesSessionId,
    );
  }
}
