// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { LocalRuntimeBinding } from "../agentera-agent-control/runtime-binding-store";
import {
  openAgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualityDatabase,
  type AgenteraOfficialQualitySqliteDatabase,
} from "./db";
import {
  OfficialQualityCollector,
  createOfficialQualityBindingResolver,
  type OfficialQualityBindingProvenance,
} from "./collector";
import type { AgenteraControlPlaneDatabase } from "../agentera-agent-control/db";

const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001";
const DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const PLATFORM_ID = "30000000-0000-4000-8000-000000000001";
const DEFINITION_ID = "40000000-0000-4000-8000-000000000001";
const VERSION_ID = "50000000-0000-4000-8000-000000000001";
const RELEASE_ID = "60000000-0000-4000-8000-000000000001";
const RELEASE_REVISION_ID = "70000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "80000000-0000-4000-8000-000000000001";
const BINDING_ID = "90000000-0000-4000-8000-000000000001";
const POLICY_ID = "a0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-23T12:00:10.000Z");

function binding(
  overrides: Partial<LocalRuntimeBinding> = {},
): LocalRuntimeBinding {
  return {
    id: BINDING_ID,
    conversationKey: "run-private",
    hermesSessionId: null,
    tenantId: "b0000000-0000-4000-8000-000000000001",
    ownerScope: "USER",
    ownerId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    agentDefinitionId: DEFINITION_ID,
    agentVersionId: VERSION_ID,
    agentInstallationId: INSTALLATION_ID,
    runtimeProfileId: "c0000000-0000-4000-8000-000000000001",
    runtimeVersion: "v0.18.2-agentera.1",
    policySnapshotId: POLICY_ID,
    officialReleaseRevisionId: RELEASE_REVISION_ID,
    toolPermissionDigest: "ab".repeat(32),
    publishedBaseDigest: "cd".repeat(32),
    localAdaptiveStateRevision: "d0000000-0000-4000-8000-000000000001",
    createdAt: "2026-07-23T12:00:00.000Z",
    ...overrides,
  };
}

function provenance(): OfficialQualityBindingProvenance {
  return {
    platformId: PLATFORM_ID,
    definitionId: DEFINITION_ID,
    versionId: VERSION_ID,
    releaseId: RELEASE_ID,
    releaseRevisionId: RELEASE_REVISION_ID,
    runtimeVersion: "v0.18.2-agentera.1",
    bindingProof: BINDING_ID,
  };
}

function devicePrivateKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return (
    privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
  ).toString("base64");
}

describe("OfficialQualityCollector", () => {
  let root = "";
  let database: AgenteraOfficialQualityDatabase;
  let resolveBinding: Mock<
    (binding: LocalRuntimeBinding) => OfficialQualityBindingProvenance | null
  >;
  let collector: OfficialQualityCollector;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentera-quality-collector-"));
    database = openAgenteraOfficialQualityDatabase(join(root, "user-data"), {
      databaseFactory: (path) =>
        new DatabaseSync(
          path,
        ) as unknown as AgenteraOfficialQualitySqliteDatabase,
    });
    resolveBinding = vi.fn<
      (binding: LocalRuntimeBinding) => OfficialQualityBindingProvenance | null
    >(() => provenance());
    collector = new OfficialQualityCollector({
      database,
      desktopVersion: "0.7.3",
      getPrincipal: () => ({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        devicePrivateKey: devicePrivateKey(),
      }),
      resolveBinding,
      now: () => NOW,
      randomUUIDv7: () => "019f0000-0000-7000-8000-000000000001",
    });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  function count(): number {
    return (
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM official_quality_outbox")
        .get() as { count: number }
    ).count;
  }

  it("creates no row for default-off consent, non-official bindings, or missing provenance", () => {
    expect(
      collector.collectMetric({
        binding: binding(),
        startedAt: NOW.getTime() - 1_200,
        endedAt: NOW.getTime(),
        totalTokens: 25,
        result: "success",
        crashCode: null,
      }),
    ).toBeNull();
    expect(resolveBinding).not.toHaveBeenCalled();

    database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_quality_metrics",
      true,
      NOW,
    );
    expect(
      collector.collectMetric({
        binding: binding({ officialReleaseRevisionId: null }),
        startedAt: NOW.getTime() - 1_200,
        endedAt: NOW.getTime(),
        totalTokens: 25,
        result: "success",
        crashCode: null,
      }),
    ).toBeNull();
    resolveBinding.mockReturnValueOnce(null);
    expect(
      collector.collectMetric({
        binding: binding(),
        startedAt: NOW.getTime() - 1_200,
        endedAt: NOW.getTime(),
        totalTokens: 25,
        result: "success",
        crashCode: null,
      }),
    ).toBeNull();
    expect(count()).toBe(0);
  });

  it("rejects malformed usage instead of guessing or persisting it", () => {
    database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_quality_metrics",
      true,
      NOW,
    );
    for (const totalTokens of [-1, 1.5, Number.NaN, "25", undefined]) {
      expect(
        collector.collectMetric({
          binding: binding(),
          startedAt: NOW.getTime() - 1_200,
          endedAt: NOW.getTime(),
          totalTokens,
          result: "success",
          crashCode: null,
        }),
      ).toBeNull();
    }
    expect(count()).toBe(0);
  });

  it("signs and queues only the minimized official terminal envelope", () => {
    const consent = database.setConsent(
      ACCOUNT_ID,
      DEVICE_ID,
      "official_quality_metrics",
      true,
      NOW,
    );
    const event = collector.collectMetric({
      binding: binding(),
      startedAt: NOW.getTime() - 6_000,
      endedAt: NOW.getTime(),
      totalTokens: 4_500,
      result: "tool_error",
      crashCode: null,
    });

    expect(event).toMatchObject({
      protocol_version: 1,
      consent_version: consent.version,
      event_id: "019f0000-0000-7000-8000-000000000001",
      platform_id: PLATFORM_ID,
      definition_id: DEFINITION_ID,
      version_id: VERSION_ID,
      release_id: RELEASE_ID,
      release_revision_id: RELEASE_REVISION_ID,
      desktop_version: "0.7.3",
      runtime_version: "v0.18.2-agentera.1",
      event_day: "2026-07-23",
      kind: "metric",
      result: "tool_error",
      latency_bucket: "5s_15s",
      total_token_bucket: "4k_16k",
      crash_code: null,
      feedback_rating: null,
      feedback_reason_codes: [],
      binding_proof: BINDING_ID,
    });
    expect(event?.device_signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(count()).toBe(1);
    const serialized = JSON.stringify(event);
    for (const forbidden of [
      "run-private",
      "hermesSessionId",
      "runtimeProfileId",
      "localAdaptiveStateRevision",
      "toolPermissionDigest",
      "publishedBaseDigest",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("resolves platform and release identity only from matching verified local policy state", () => {
    const row = {
      source_scope: "PLATFORM",
      official_release_id: RELEASE_ID,
      selected_release_revision_id: RELEASE_REVISION_ID,
      update_policy: "managed",
      definition_id: DEFINITION_ID,
      selected_version_id: VERSION_ID,
      runtime_profile_id: binding().runtimeProfileId,
      policy_snapshot_id: POLICY_ID,
      status: "active",
      policy_snapshot_json: JSON.stringify({
        schema_version: 1,
        snapshots: [
          {
            id: POLICY_ID,
            installation_id: INSTALLATION_ID,
            agent_version_id: VERSION_ID,
            document: {
              official_context: {
                device_installation_id: DEVICE_ID,
                installation_id: INSTALLATION_ID,
                platform_id: PLATFORM_ID,
                product_context_id: binding().tenantId,
                product_scope: "USER",
                release_id: RELEASE_ID,
                release_revision_id: RELEASE_REVISION_ID,
                user_id: ACCOUNT_ID,
              },
            },
          },
        ],
      }),
    };
    const get = vi.fn(() => row);
    const resolver = createOfficialQualityBindingResolver({
      sqlite: { prepare: vi.fn(() => ({ get })) },
    } as unknown as AgenteraControlPlaneDatabase);

    expect(resolver(binding())).toEqual(provenance());
    expect(get).toHaveBeenCalledWith(
      INSTALLATION_ID,
      binding().tenantId,
      ACCOUNT_ID,
      DEVICE_ID,
    );

    row.source_scope = "WORKSPACE";
    expect(resolver(binding())).toBeNull();
  });
});
