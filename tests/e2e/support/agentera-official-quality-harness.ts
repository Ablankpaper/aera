import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LocalRuntimeBinding } from "../../../src/main/agentera-agent-control/runtime-binding-store";
import { AgenteraOfficialQualityClient } from "../../../src/main/agentera-official-quality/client";
import {
  OfficialQualityCollector,
  createOfficialQualityChatObserver,
  type OfficialQualityBindingProvenance,
} from "../../../src/main/agentera-official-quality/collector";
import {
  openAgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualitySqliteDatabase,
} from "../../../src/main/agentera-official-quality/db";
import { AgenteraOfficialQualityManager } from "../../../src/main/agentera-official-quality/manager";
import type {
  OfficialQualityEnvelope,
  OfficialQualityFeedbackEligibility,
  OfficialQualityFeedbackSubmission,
} from "../../../src/shared/agentera-official-quality";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const PLATFORM_ID = "30000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "40000000-0000-4000-8000-000000000001";
const VERSION_V1_ID = "50000000-0000-4000-8000-000000000001";
const VERSION_V2_ID = "50000000-0000-4000-8000-000000000002";
const RELEASE_ID = "60000000-0000-4000-8000-000000000001";
const RELEASE_REVISION_V1_ID = "70000000-0000-4000-8000-000000000001";
const RELEASE_REVISION_V2_ID = "70000000-0000-4000-8000-000000000002";
const INSTALLATION_ID = "80000000-0000-4000-8000-000000000001";
const BINDING_V1_ID = "90000000-0000-4000-8000-000000000001";
const BINDING_V2_ID = "90000000-0000-4000-8000-000000000002";
const POLICY_ID = "a0000000-0000-4000-8000-000000000001";
const TENANT_ID = "b0000000-0000-4000-8000-000000000001";
const PROFILE_ID = "c0000000-0000-4000-8000-000000000001";
const ADAPTIVE_REVISION_ID = "d0000000-0000-4000-8000-000000000001";
const CLOUD_ORIGIN = "https://quality.agentera.test";
const INITIAL_NOW = new Date("2026-07-23T12:00:00.000Z");

function privateDeviceKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return (
    privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
  ).toString("base64");
}

function binding(
  id: string,
  versionId: string,
  releaseRevisionId: string,
): LocalRuntimeBinding {
  return Object.freeze({
    id,
    conversationKey: `private-${id}`,
    hermesSessionId: null,
    tenantId: TENANT_ID,
    ownerScope: "USER",
    ownerId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    agentDefinitionId: DEFINITION_ID,
    agentVersionId: versionId,
    agentInstallationId: INSTALLATION_ID,
    runtimeProfileId: PROFILE_ID,
    runtimeVersion: "v0.18.2-agentera.1",
    policySnapshotId: POLICY_ID,
    officialReleaseRevisionId: releaseRevisionId,
    toolPermissionDigest: "ab".repeat(32),
    publishedBaseDigest: "cd".repeat(32),
    localAdaptiveStateRevision: ADAPTIVE_REVISION_ID,
    createdAt: INITIAL_NOW.toISOString(),
  });
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface OfficialQualityFakeCloud {
  eventBodies: OfficialQualityEnvelope[];
  eventAttempts: number;
  failEventUploads: boolean;
}

export interface OfficialQualityE2EHarness {
  cloud: OfficialQualityFakeCloud;
  v1Binding: LocalRuntimeBinding;
  v2Binding: LocalRuntimeBinding;
  unusedEventId: string;
  setPassiveConsent(enabled: boolean): Promise<void>;
  setExplicitFeedbackConsent(enabled: boolean): Promise<void>;
  completeSuccessfulTurn(
    selectedBinding: LocalRuntimeBinding,
    options?: {
      latencyMilliseconds?: number;
      totalTokens?: number;
    },
  ): {
    chatCompleted: true;
    feedbackEligibility: OfficialQualityFeedbackEligibility | null;
  };
  submitFeedback(input: OfficialQualityFeedbackSubmission): Promise<void>;
  flush(): Promise<void>;
  outboxCount(): number;
  advancePastRetryWindow(): void;
  close(): void;
}

export function createOfficialQualityE2EHarness(): OfficialQualityE2EHarness {
  const root = mkdtempSync(join(tmpdir(), "agentera-quality-e2e-"));
  const database: AgenteraOfficialQualityDatabase =
    openAgenteraOfficialQualityDatabase(join(root, "user-data"), {
      databaseFactory: (path) =>
        new DatabaseSync(
          path,
        ) as unknown as AgenteraOfficialQualitySqliteDatabase,
    });
  const devicePrivateKey = privateDeviceKey();
  let now = new Date(INITIAL_NOW);
  let nextEventSequence = 1;
  let closed = false;
  const cloud: OfficialQualityFakeCloud = {
    eventBodies: [],
    eventAttempts: 0,
    failEventUploads: false,
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const parsed = new URL(url);
    const authorization = new Headers(init?.headers).get("authorization");
    if (parsed.origin !== CLOUD_ORIGIN || authorization !== "Bearer e2e-token") {
      return response(401, { error: "session_revoked" });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    const consentMatch = parsed.pathname.match(
      /^\/api\/v1\/official-agent-quality\/consents\/(official_quality_metrics|official_explicit_feedback)\/(grant|revoke)$/,
    );
    if (consentMatch) {
      const purpose = consentMatch[1] as
        | "official_quality_metrics"
        | "official_explicit_feedback";
      const enabled = consentMatch[2] === "grant";
      return response(200, {
        purpose,
        consent_version: body.consent_version,
        state: enabled ? "granted" : "revoked",
        revision: body.consent_version,
        recorded_at: now.toISOString(),
        replayed: false,
      });
    }
    if (parsed.pathname === "/api/v1/official-agent-quality/events") {
      cloud.eventAttempts += 1;
      if (cloud.failEventUploads) {
        throw new Error("quality endpoint intentionally unavailable");
      }
      const envelope = body as unknown as OfficialQualityEnvelope;
      cloud.eventBodies.push(structuredClone(envelope));
      return response(202, {
        event_id: envelope.event_id,
        status: "accepted",
      });
    }
    return response(404, { error: "invalid_request" });
  };

  const principal = {
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    devicePrivateKey,
  };
  const v1Binding = binding(
    BINDING_V1_ID,
    VERSION_V1_ID,
    RELEASE_REVISION_V1_ID,
  );
  const v2Binding = binding(
    BINDING_V2_ID,
    VERSION_V2_ID,
    RELEASE_REVISION_V2_ID,
  );
  const resolveBinding = (
    selectedBinding: LocalRuntimeBinding,
  ): OfficialQualityBindingProvenance | null => {
    if (
      selectedBinding.id !== BINDING_V1_ID &&
      selectedBinding.id !== BINDING_V2_ID
    ) {
      return null;
    }
    return {
      platformId: PLATFORM_ID,
      definitionId: selectedBinding.agentDefinitionId,
      versionId: selectedBinding.agentVersionId,
      releaseId: RELEASE_ID,
      releaseRevisionId: selectedBinding.officialReleaseRevisionId!,
      runtimeVersion: selectedBinding.runtimeVersion,
      bindingProof: selectedBinding.id,
    };
  };
  const collector = new OfficialQualityCollector({
    database,
    desktopVersion: "0.7.3-e2e",
    getPrincipal: () => principal,
    resolveBinding,
    now: () => new Date(now),
    randomUUIDv7: () => {
      const suffix = nextEventSequence.toString(16).padStart(12, "0");
      nextEventSequence += 1;
      return `019f0000-0000-7000-8000-${suffix}`;
    },
  });
  const client = new AgenteraOfficialQualityClient({
    origin: CLOUD_ORIGIN,
    getAccessToken: () => "e2e-token",
    fetch: fakeFetch,
    now: () => new Date(now),
  });
  const manager = new AgenteraOfficialQualityManager({
    database,
    client,
    collector,
    getPrincipal: () => principal,
    now: () => new Date(now),
    random: () => 0,
  });

  const synchronizeConsent = async (
    purpose:
      | "official_quality_metrics"
      | "official_explicit_feedback",
    enabled: boolean,
  ): Promise<void> => {
    await manager.setConsent(purpose, enabled);
    await manager.uploadPending();
  };

  return {
    cloud,
    v1Binding,
    v2Binding,
    unusedEventId: "019f0000-0000-7000-8000-00000000ffff",
    setPassiveConsent: (enabled) =>
      synchronizeConsent("official_quality_metrics", enabled),
    setExplicitFeedbackConsent: (enabled) =>
      synchronizeConsent("official_explicit_feedback", enabled),
    completeSuccessfulTurn(selectedBinding, options = {}) {
      const startedAt = now.getTime();
      const latencyMilliseconds = options.latencyMilliseconds ?? 1_500;
      let feedbackEligibility: OfficialQualityFeedbackEligibility | null = null;
      const observer = createOfficialQualityChatObserver({
        binding: selectedBinding,
        startedAt,
        now: () => startedAt + latencyMilliseconds,
        recordMetric: (input) => manager.recordMetric(input),
        onEligible: (eligibility) => {
          feedbackEligibility = eligibility;
        },
      });
      observer.onUsage({ totalTokens: options.totalTokens ?? 800 });
      observer.onDone();
      return { chatCompleted: true, feedbackEligibility };
    },
    async submitFeedback(input) {
      await manager.submitFeedback(input);
    },
    flush: () => manager.uploadPending(),
    outboxCount: () => database.countOutbox(ACCOUNT_ID, DEVICE_ID),
    advancePastRetryWindow() {
      now = new Date(now.getTime() + 10_000);
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
