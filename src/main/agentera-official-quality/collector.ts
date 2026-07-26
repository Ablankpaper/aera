import { createPrivateKey, randomBytes, sign } from "node:crypto";
import type { InstallationIdentity } from "../agentera-auth/store";
import type { AgenteraControlPlaneDatabase } from "../agentera-agent-control/db";
import type { LocalRuntimeBinding } from "../agentera-agent-control/runtime-binding-store";
import {
  AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION,
  type OfficialQualityCrashCode,
  type OfficialQualityEnvelope,
  type OfficialQualityFeedbackEligibility,
  type OfficialQualityFeedbackRating,
  type OfficialQualityFeedbackReasonCode,
  type OfficialQualityLatencyBucket,
  type OfficialQualityResult,
  type OfficialQualityTokenBucket,
} from "../../shared/agentera-official-quality";
import type { AgenteraOfficialQualityDatabase } from "./db";
import {
  bucketOfficialQualityLatency,
  bucketOfficialQualityTotalTokens,
  parseOfficialQualityResult,
} from "./minimizer";
import { parseOfficialQualityEnvelope } from "./model";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_SIGNATURE_DOMAIN = "official-quality-event-v1\0";

export interface OfficialQualityPrincipal {
  accountId: string;
  deviceId: string;
}

export interface OfficialQualitySigningPrincipal
  extends
    OfficialQualityPrincipal,
    Pick<InstallationIdentity, "devicePrivateKey"> {}

export interface OfficialQualityBindingProvenance {
  platformId: string;
  definitionId: string;
  versionId: string;
  releaseId: string;
  releaseRevisionId: string;
  runtimeVersion: string;
  bindingProof: string;
}

export interface CollectOfficialQualityMetricInput {
  binding: LocalRuntimeBinding;
  startedAt: unknown;
  endedAt: unknown;
  totalTokens: unknown;
  result: OfficialQualityResult;
  crashCode: OfficialQualityCrashCode | null;
}

export interface OfficialQualityMetricCollector {
  collectMetric(
    input: CollectOfficialQualityMetricInput,
  ): OfficialQualityEnvelope | null;
  prepareFeedbackCandidate(
    input: CollectOfficialQualityMetricInput,
  ): OfficialQualityFeedbackCandidate | null;
  collectFeedback(
    candidate: OfficialQualityFeedbackCandidate,
    input: CollectOfficialQualityFeedbackInput,
  ): OfficialQualityEnvelope | null;
}

export interface CollectOfficialQualityFeedbackInput {
  rating: OfficialQualityFeedbackRating;
  reasonCodes: OfficialQualityFeedbackReasonCode[];
}

/** Main-process-only content-free terminal snapshot. Never persisted as-is. */
export interface OfficialQualityFeedbackCandidate {
  candidateId: string;
  accountId: string;
  deviceId: string;
  consentVersion: number;
  preparedAt: string;
  platformId: string;
  definitionId: string;
  versionId: string;
  releaseId: string;
  releaseRevisionId: string;
  desktopVersion: string;
  runtimeVersion: string;
  eventDay: string;
  result: OfficialQualityResult;
  latencyBucket: OfficialQualityLatencyBucket;
  totalTokenBucket: OfficialQualityTokenBucket;
  crashCode: OfficialQualityCrashCode | null;
  bindingProof: string;
}

export interface OfficialQualityCollectorOptions {
  database: AgenteraOfficialQualityDatabase;
  desktopVersion: string;
  getPrincipal: () => OfficialQualitySigningPrincipal | null;
  resolveBinding: (
    binding: LocalRuntimeBinding,
  ) => OfficialQualityBindingProvenance | null;
  now?: () => Date;
  randomUUIDv7?: () => string;
}

interface OfficialInstallationRow {
  source_scope?: unknown;
  official_release_id?: unknown;
  selected_release_revision_id?: unknown;
  update_policy?: unknown;
  definition_id?: unknown;
  selected_version_id?: unknown;
  runtime_profile_id?: unknown;
  policy_snapshot_id?: unknown;
  status?: unknown;
  policy_snapshot_json?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalUUID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UUID_PATTERN.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000"
  );
}

function exactKeys(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function parsePolicyOfficialContext(
  rawCollection: unknown,
  binding: LocalRuntimeBinding,
): { platformId: string; releaseId: string; releaseRevisionId: string } | null {
  if (typeof rawCollection !== "string" || rawCollection.length > 1024 * 1024) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCollection);
  } catch {
    return null;
  }
  if (
    !isObject(parsed) ||
    !exactKeys(parsed, ["schema_version", "snapshots"]) ||
    parsed.schema_version !== 1 ||
    !Array.isArray(parsed.snapshots) ||
    parsed.snapshots.length > 256
  ) {
    return null;
  }
  const snapshot = parsed.snapshots.find(
    (candidate) =>
      isObject(candidate) && candidate.id === binding.policySnapshotId,
  );
  if (
    !isObject(snapshot) ||
    snapshot.installation_id !== binding.agentInstallationId ||
    snapshot.agent_version_id !== binding.agentVersionId ||
    !isObject(snapshot.document) ||
    !isObject(snapshot.document.official_context)
  ) {
    return null;
  }
  const context = snapshot.document.official_context;
  if (
    !exactKeys(context, [
      "device_installation_id",
      "installation_id",
      "platform_id",
      "product_context_id",
      "product_scope",
      "release_id",
      "release_revision_id",
      "user_id",
    ]) ||
    !canonicalUUID(context.platform_id) ||
    !canonicalUUID(context.release_id) ||
    !canonicalUUID(context.release_revision_id) ||
    context.release_revision_id !== binding.officialReleaseRevisionId ||
    context.user_id !== binding.ownerId ||
    context.device_installation_id !== binding.deviceId ||
    context.installation_id !== binding.agentInstallationId ||
    (context.product_scope !== "USER" &&
      context.product_scope !== "WORKSPACE" &&
      context.product_scope !== "ORGANIZATION") ||
    !canonicalUUID(context.product_context_id)
  ) {
    return null;
  }
  return {
    platformId: context.platform_id,
    releaseId: context.release_id,
    releaseRevisionId: context.release_revision_id,
  };
}

/** Resolve only already-verified official provenance from the local control plane. */
export function createOfficialQualityBindingResolver(
  database: AgenteraControlPlaneDatabase,
): (binding: LocalRuntimeBinding) => OfficialQualityBindingProvenance | null {
  return (binding) => {
    if (binding.officialReleaseRevisionId === null) return null;
    const row = database.sqlite
      .prepare(
        `SELECT installation.source_scope, installation.official_release_id,
                installation.selected_release_revision_id,
                installation.update_policy, installation.definition_id,
                installation.selected_version_id,
                installation.runtime_profile_id,
                installation.policy_snapshot_id, installation.status,
                version.policy_snapshot_json
         FROM local_agent_installations installation
         JOIN cached_agent_versions version
           ON version.tenant_id = installation.tenant_id
          AND version.owner_id = installation.owner_id
          AND version.version_id = installation.selected_version_id
          AND version.definition_id = installation.definition_id
         WHERE installation.agent_installation_id = ?
           AND installation.tenant_id = ?
           AND installation.owner_id = ?
           AND installation.device_installation_id = ?`,
      )
      .get(
        binding.agentInstallationId,
        binding.tenantId,
        binding.ownerId,
        binding.deviceId,
      ) as OfficialInstallationRow | undefined;
    if (
      !row ||
      row.source_scope !== "PLATFORM" ||
      row.update_policy !== "managed" ||
      row.status !== "active" ||
      row.definition_id !== binding.agentDefinitionId ||
      row.selected_version_id !== binding.agentVersionId ||
      row.runtime_profile_id !== binding.runtimeProfileId ||
      row.policy_snapshot_id !== binding.policySnapshotId ||
      row.selected_release_revision_id !== binding.officialReleaseRevisionId ||
      !canonicalUUID(row.official_release_id)
    ) {
      return null;
    }
    const context = parsePolicyOfficialContext(
      row.policy_snapshot_json,
      binding,
    );
    if (!context || context.releaseId !== row.official_release_id) return null;
    return {
      platformId: context.platformId,
      definitionId: binding.agentDefinitionId,
      versionId: binding.agentVersionId,
      releaseId: context.releaseId,
      releaseRevisionId: context.releaseRevisionId,
      runtimeVersion: binding.runtimeVersion,
      bindingProof: binding.id,
    };
  };
}

function officialQualityUUIDv7(now = new Date()): string {
  const timestamp = now.getTime();
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp >= 2 ** 48
  ) {
    throw new Error("Invalid official quality event time.");
  }
  const bytes = randomBytes(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function signingBytes(
  envelope: Omit<OfficialQualityEnvelope, "device_signature">,
): Buffer {
  return Buffer.from(EVENT_SIGNATURE_DOMAIN + JSON.stringify(envelope), "utf8");
}

function deviceSignature(privateKeyValue: string, bytes: Buffer): string {
  const privateBytes = Buffer.from(privateKeyValue, "base64");
  if (
    privateBytes.length === 0 ||
    privateBytes.toString("base64") !== privateKeyValue
  ) {
    throw new Error("Invalid official quality device identity.");
  }
  const privateKey = createPrivateKey({
    key: privateBytes,
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, bytes, privateKey).toString("base64url");
  if (signature.length !== 86) {
    throw new Error("Invalid official quality device signature.");
  }
  return signature;
}

export class OfficialQualityCollector implements OfficialQualityMetricCollector {
  private readonly options: OfficialQualityCollectorOptions;

  constructor(options: OfficialQualityCollectorOptions) {
    if (
      !options ||
      !options.database ||
      typeof options.desktopVersion !== "string" ||
      options.desktopVersion.length < 1 ||
      options.desktopVersion.length > 128 ||
      typeof options.getPrincipal !== "function" ||
      typeof options.resolveBinding !== "function"
    ) {
      throw new Error("Invalid official quality collector configuration.");
    }
    this.options = options;
  }

  collectMetric(
    input: CollectOfficialQualityMetricInput,
  ): OfficialQualityEnvelope | null {
    try {
      const principal = this.options.getPrincipal();
      if (!principal) return null;
      const consent = this.options.database.readConsentReceipt(
        principal.accountId,
        principal.deviceId,
        "official_quality_metrics",
      );
      if (!consent.enabled || consent.version < 1) return null;
      const prepared = this.prepareTerminal(input, principal);
      if (!prepared) return null;
      const { provenance, now, result } = prepared;
      const unsigned: Omit<OfficialQualityEnvelope, "device_signature"> = {
        protocol_version: AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION,
        consent_version: consent.version,
        event_id: this.options.randomUUIDv7?.() ?? officialQualityUUIDv7(now),
        platform_id: provenance.platformId,
        definition_id: provenance.definitionId,
        version_id: provenance.versionId,
        release_id: provenance.releaseId,
        release_revision_id: provenance.releaseRevisionId,
        desktop_version: this.options.desktopVersion,
        runtime_version: provenance.runtimeVersion,
        event_day: now.toISOString().slice(0, 10),
        kind: "metric",
        result,
        latency_bucket: prepared.latencyBucket,
        total_token_bucket: prepared.totalTokenBucket,
        crash_code: input.crashCode,
        feedback_rating: null,
        feedback_reason_codes: [],
        binding_proof: provenance.bindingProof,
      };
      const envelope = parseOfficialQualityEnvelope(
        {
          ...unsigned,
          device_signature: deviceSignature(
            principal.devicePrivateKey,
            signingBytes(unsigned),
          ),
        },
        now,
      );
      return this.options.database.enqueue({
        accountId: principal.accountId,
        deviceId: principal.deviceId,
        purpose: "official_quality_metrics",
        envelope,
        now,
      });
    } catch {
      return null;
    }
  }

  prepareFeedbackCandidate(
    input: CollectOfficialQualityMetricInput,
  ): OfficialQualityFeedbackCandidate | null {
    try {
      const principal = this.options.getPrincipal();
      if (!principal) return null;
      const consent = this.options.database.readConsentReceipt(
        principal.accountId,
        principal.deviceId,
        "official_explicit_feedback",
      );
      if (!consent.enabled || consent.version < 1) return null;
      const prepared = this.prepareTerminal(input, principal);
      if (!prepared || prepared.result !== "success") return null;
      return Object.freeze({
        candidateId:
          this.options.randomUUIDv7?.() ?? officialQualityUUIDv7(prepared.now),
        accountId: prepared.principal.accountId,
        deviceId: prepared.principal.deviceId,
        consentVersion: consent.version,
        preparedAt: prepared.now.toISOString(),
        platformId: prepared.provenance.platformId,
        definitionId: prepared.provenance.definitionId,
        versionId: prepared.provenance.versionId,
        releaseId: prepared.provenance.releaseId,
        releaseRevisionId: prepared.provenance.releaseRevisionId,
        desktopVersion: this.options.desktopVersion,
        runtimeVersion: prepared.provenance.runtimeVersion,
        eventDay: prepared.now.toISOString().slice(0, 10),
        result: prepared.result,
        latencyBucket: prepared.latencyBucket,
        totalTokenBucket: prepared.totalTokenBucket,
        crashCode: prepared.crashCode,
        bindingProof: prepared.provenance.bindingProof,
      });
    } catch {
      return null;
    }
  }

  collectFeedback(
    candidate: OfficialQualityFeedbackCandidate,
    input: CollectOfficialQualityFeedbackInput,
  ): OfficialQualityEnvelope | null {
    try {
      const principal = this.options.getPrincipal();
      const now = this.options.now?.() ?? new Date();
      const preparedAt = new Date(candidate.preparedAt).getTime();
      if (
        !principal ||
        candidate.accountId !== principal.accountId ||
        candidate.deviceId !== principal.deviceId ||
        !Number.isFinite(preparedAt) ||
        preparedAt > now.getTime() ||
        now.getTime() - preparedAt > 30 * 60 * 1_000
      ) {
        return null;
      }
      const consent = this.options.database.readConsentReceipt(
        principal.accountId,
        principal.deviceId,
        "official_explicit_feedback",
      );
      if (
        !consent.enabled ||
        consent.version < 1 ||
        consent.version !== candidate.consentVersion
      ) {
        return null;
      }
      const unsigned: Omit<OfficialQualityEnvelope, "device_signature"> = {
        protocol_version: AGENTERA_OFFICIAL_QUALITY_PROTOCOL_VERSION,
        consent_version: consent.version,
        event_id: candidate.candidateId,
        platform_id: candidate.platformId,
        definition_id: candidate.definitionId,
        version_id: candidate.versionId,
        release_id: candidate.releaseId,
        release_revision_id: candidate.releaseRevisionId,
        desktop_version: candidate.desktopVersion,
        runtime_version: candidate.runtimeVersion,
        event_day: candidate.eventDay,
        kind: "explicit_feedback",
        result: candidate.result,
        latency_bucket: candidate.latencyBucket,
        total_token_bucket: candidate.totalTokenBucket,
        crash_code: candidate.crashCode,
        feedback_rating: input.rating,
        feedback_reason_codes: [...input.reasonCodes],
        binding_proof: candidate.bindingProof,
      };
      const envelope = parseOfficialQualityEnvelope(
        {
          ...unsigned,
          device_signature: deviceSignature(
            principal.devicePrivateKey,
            signingBytes(unsigned),
          ),
        },
        now,
      );
      return this.options.database.enqueue({
        accountId: principal.accountId,
        deviceId: principal.deviceId,
        purpose: "official_explicit_feedback",
        envelope,
        now,
      });
    } catch {
      return null;
    }
  }

  private prepareTerminal(
    input: CollectOfficialQualityMetricInput,
    principal: OfficialQualitySigningPrincipal,
  ): {
    principal: OfficialQualitySigningPrincipal;
    provenance: OfficialQualityBindingProvenance;
    now: Date;
    result: OfficialQualityResult;
    latencyBucket: OfficialQualityLatencyBucket;
    totalTokenBucket: OfficialQualityTokenBucket;
    crashCode: OfficialQualityCrashCode | null;
  } | null {
    if (
      input.binding.ownerScope !== "USER" ||
      input.binding.ownerId !== principal.accountId ||
      input.binding.deviceId !== principal.deviceId ||
      input.binding.officialReleaseRevisionId === null
    ) {
      return null;
    }
    const provenance = this.options.resolveBinding(input.binding);
    if (
      provenance === null ||
      provenance.definitionId !== input.binding.agentDefinitionId ||
      provenance.versionId !== input.binding.agentVersionId ||
      provenance.releaseRevisionId !==
        input.binding.officialReleaseRevisionId ||
      provenance.runtimeVersion !== input.binding.runtimeVersion ||
      provenance.bindingProof !== input.binding.id
    ) {
      return null;
    }
    if (
      typeof input.startedAt !== "number" ||
      typeof input.endedAt !== "number" ||
      !Number.isSafeInteger(input.startedAt) ||
      !Number.isSafeInteger(input.endedAt) ||
      input.startedAt < 0 ||
      input.endedAt < input.startedAt
    ) {
      return null;
    }
    const result = parseOfficialQualityResult(input.result);
    if ((result === "runtime_crash") !== (input.crashCode !== null)) {
      return null;
    }
    return {
      principal,
      provenance,
      now: this.options.now?.() ?? new Date(),
      result,
      latencyBucket: bucketOfficialQualityLatency(
        input.endedAt - input.startedAt,
      ),
      totalTokenBucket: bucketOfficialQualityTotalTokens(input.totalTokens),
      crashCode: input.crashCode,
    };
  }
}

export interface OfficialQualityChatObserverOptions {
  binding: LocalRuntimeBinding | null;
  startedAt: number;
  now?: () => number;
  recordMetric: (
    input: CollectOfficialQualityMetricInput,
  ) => OfficialQualityFeedbackEligibility | null;
  onEligible?: (eligibility: OfficialQualityFeedbackEligibility) => void;
}

export interface OfficialQualityChatObserver {
  onUsage(value: unknown): void;
  onDone(): void;
  onError(error: unknown): void;
}

function classifyTerminalError(error: unknown): {
  result: OfficialQualityResult;
  crashCode: OfficialQualityCrashCode | null;
} {
  const normalized = typeof error === "string" ? error.toLowerCase() : "";
  if (normalized.includes("cancel") || normalized.includes("abort")) {
    return { result: "user_cancelled", crashCode: null };
  }
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return { result: "timeout", crashCode: null };
  }
  if (
    normalized.includes("runtime process exit") ||
    normalized.includes("runtime process exited")
  ) {
    return { result: "runtime_crash", crashCode: "runtime_process_exit" };
  }
  if (normalized.includes("gateway") && normalized.includes("unavailable")) {
    return { result: "runtime_crash", crashCode: "gateway_unavailable" };
  }
  if (
    normalized.includes("runtime protocol") ||
    normalized.includes("bound hermes api transport")
  ) {
    return {
      result: "runtime_crash",
      crashCode: "runtime_protocol_failure",
    };
  }
  if (normalized.includes("tool")) {
    return { result: "tool_error", crashCode: null };
  }
  return { result: "model_error", crashCode: null };
}

/** Build the content-discarding terminal bridge used by the chat IPC handler. */
export function createOfficialQualityChatObserver(
  options: OfficialQualityChatObserverOptions,
): OfficialQualityChatObserver {
  let totalTokens: number | null = null;
  let terminal = false;
  const record = (
    result: OfficialQualityResult,
    crashCode: OfficialQualityCrashCode | null,
  ): void => {
    if (terminal) return;
    terminal = true;
    if (!options.binding) return;
    try {
      const eligibility = options.recordMetric({
        binding: options.binding,
        startedAt: options.startedAt,
        endedAt: (options.now ?? Date.now)(),
        totalTokens,
        result,
        crashCode,
      });
      if (result === "success" && eligibility) {
        options.onEligible?.(eligibility);
      }
    } catch {
      // Quality collection is best effort and never changes chat completion.
    }
  };
  return {
    onUsage(value) {
      if (!isObject(value)) return;
      const candidate = value.totalTokens;
      totalTokens =
        typeof candidate === "number" &&
        Number.isSafeInteger(candidate) &&
        candidate >= 0
          ? candidate
          : null;
    },
    onDone() {
      record("success", null);
    },
    onError(error) {
      const classified = classifyTerminalError(error);
      record(classified.result, classified.crashCode);
    },
  };
}
