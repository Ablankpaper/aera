import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "playwright/test";

import type {
  AgentDraftDetail,
  AgenteraAgentControlResult,
  CreateAgentDraftInput,
  PublishedRevision,
} from "../../src/shared/agentera-agent-control";
import type {
  AgenteraEncryptedBackupConfirmedRestore,
  AgenteraEncryptedBackupCreationResult,
  AgenteraEncryptedBackupPreparedRestore,
  AgenteraEncryptedBackupPublicDevice,
  AgenteraEncryptedBackupPublicEnrollment,
  AgenteraEncryptedBackupPublicState,
  AgenteraEncryptedBackupPublicSummary,
} from "../../src/shared/agentera-encrypted-backup";
import { recoveryPhraseFromEntropy } from "../../src/main/agentera-encrypted-backup/crypto";
import {
  authenticateExistingAgentControlDevice,
  authenticateFirstAgentControlDevice,
  claimDefaultProfile,
  closeAgentControlHarness,
  createAgentControlHarness,
  deviceProfilePath,
  failNextEncryptedBackupChunkUpload,
  invokeAgentera,
  launchAgentControlDevice,
  localAgentControlState,
  privateProfileSnapshot,
  startBoundConversation,
  type AgentControlDevice,
  type AgentControlHarness,
} from "./support/agentera-agent-control-harness";
import {
  encryptedBackupCloudRecord,
  encryptedBackupObjectCount,
  encryptedBackupPostgresDump,
  inspectEncryptedBackupObjects,
  startEncryptedBackupMinIO,
  stopEncryptedBackupMinIO,
  tamperEncryptedBackupObject,
} from "./support/agentera-encrypted-backup-harness";

const MEMORY_CANARY = "ENCRYPTED_BACKUP_MEMORY_CANARY_2026_07_23";
const USER_CANARY = "ENCRYPTED_BACKUP_USER_CANARY_2026_07_23";
const SKILL_CANARY = "ENCRYPTED_BACKUP_PRIVATE_SKILL_CANARY_2026_07_23";
const SESSION_CANARY = "encrypted-backup-session-canary-2026-07-23";
const FORBIDDEN_SOURCE_CANARY =
  "ENCRYPTED_BACKUP_FORBIDDEN_ENV_CANARY_2026_07_23";
const PROFILE_MARKERS = [
  "memories/MEMORY.md",
  "memories/USER.md",
  "skills/backup-private/SKILL.md",
  ".env",
] as const;

type BackupMethod =
  | "getState"
  | "initializeRecovery"
  | "confirmRecoverySaved"
  | "registerCurrentDevice"
  | "authorizeDevice"
  | "createBackup"
  | "listBackups"
  | "deleteBackup"
  | "listDevices"
  | "revokeDevice"
  | "prepareRestore"
  | "confirmRestore";

let harness: AgentControlHarness | null = null;
let deviceA: AgentControlDevice | null = null;
let deviceB: AgentControlDevice | null = null;
let deviceC: AgentControlDevice | null = null;

test.setTimeout(600_000);

function unwrap<T>(result: AgenteraAgentControlResult<T>): T {
  if (!result.ok) {
    throw new Error(`Agent control failed: ${result.errorCode}`);
  }
  return result.data;
}

async function invokeBackup<T>(
  device: AgentControlDevice,
  method: BackupMethod,
  ...args: unknown[]
): Promise<T> {
  return device.page.evaluate(
    async ({ requestedMethod, requestedArgs }) => {
      const api = window.agenteraEncryptedBackup as unknown as Record<
        string,
        (...parameters: unknown[]) => Promise<unknown>
      >;
      return api[requestedMethod](...requestedArgs) as Promise<T>;
    },
    { requestedMethod: method, requestedArgs: args },
  );
}

function draftInput(): CreateAgentDraftInput {
  return {
    sourceAgentDefinitionId: null,
    baseAgentVersionId: null,
    displayName: "Encrypted backup source Agent",
    icon: null,
    manifest: {
      schemaVersion: 1,
      identity: {
        systemPrompt: "Preserve the immutable encrypted backup base.",
      },
      assets: [
        {
          path: "skills/base/SKILL.md",
          kind: "skill",
          mediaType: "text/markdown",
        },
      ],
      modelConstraints: {
        allowedProviders: ["openai"],
        allowedModels: ["gpt-5.6"],
      },
      tools: { allowed: [], denied: [] },
      dependencies: [],
      runtimeCompatibility: {
        minimumVersion: "v0.18.2-agentera.1",
        maximumVersionExclusive: null,
      },
    },
    assets: [
      {
        path: "skills/base/SKILL.md",
        content:
          "---\nname: base\ndescription: Immutable backup fixture\n---\n",
      },
    ],
  };
}

async function publishUserVersion(
  device: AgentControlDevice,
): Promise<PublishedRevision> {
  const draft = unwrap<AgentDraftDetail>(
    await invokeAgentera(device, "createDraft", draftInput()),
  );
  const preview = unwrap(
    await invokeAgentera(device, "preparePublication", draft.id),
  );
  return unwrap(
    await invokeAgentera<PublishedRevision>(
      device,
      "confirmPublication",
      preview.publicationHandle,
    ),
  );
}

async function waitForRuntime(device: AgentControlDevice): Promise<void> {
  await expect
    .poll(() =>
      device.page.evaluate(() => window.agenteraRuntimeDistribution.getState()),
    )
    .toMatchObject({ phase: "current" });
}

async function seedPrivateProfile(profilePath: string): Promise<void> {
  const files: Record<string, string> = {
    "memories/MEMORY.md": `${MEMORY_CANARY}\n`,
    "memories/USER.md": `${USER_CANARY}\n`,
    "skills/backup-private/SKILL.md": `# Private backup Skill\n${SKILL_CANARY}\n`,
    ".env": `PRIVATE_TOKEN=${FORBIDDEN_SOURCE_CANARY}\n`,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(profilePath, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
}

function seedSessionDatabase(profilePath: string): void {
  const database = new DatabaseSync(join(profilePath, "state.db"));
  try {
    database.exec(
      "CREATE TABLE encrypted_backup_e2e_sessions (id TEXT PRIMARY KEY, content TEXT NOT NULL)",
    );
    database
      .prepare(
        "INSERT INTO encrypted_backup_e2e_sessions (id, content) VALUES (?, ?)",
      )
      .run("historical-session", SESSION_CANARY);
  } finally {
    database.close();
  }
}

function fileDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sessionDatabaseSnapshot(profilePath: string): {
  integrity: string;
  rows: Array<{ id: string; content: string }>;
} {
  const database = new DatabaseSync(join(profilePath, "state.db"), {
    readOnly: true,
  });
  try {
    const integrity = (
      database.prepare("PRAGMA quick_check").get() as { quick_check: string }
    ).quick_check;
    const rows = database
      .prepare(
        "SELECT id, content FROM encrypted_backup_e2e_sessions ORDER BY id",
      )
      .all() as Array<{ id: string; content: string }>;
    return { integrity, rows };
  } finally {
    database.close();
  }
}

function restoreRecordCount(
  device: AgentControlDevice,
  installationId: string,
): number {
  const database = new DatabaseSync(
    join(device.userData, "agentera-control-plane", "control-plane.db"),
    { readOnly: true },
  );
  try {
    const row = database
      .prepare(
        `SELECT count(*) AS count
         FROM encrypted_backup_restores
         WHERE agent_installation_id = ?
           AND historical_sessions_read_only = 1
           AND length(encrypted_runtime_binding_provenance) > 0`,
      )
      .get(installationId) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

test.beforeAll(async () => {
  harness = await createAgentControlHarness({ encryptedBackup: true });
});

test.afterAll(async () => {
  await closeAgentControlHarness(harness);
  harness = null;
  deviceA = null;
  deviceB = null;
  deviceC = null;
});

test("keeps Cloud ciphertext-only while authorized-device and phrase recovery create fresh Profiles", async ({
  browserName: _browserName,
}, testInfo) => {
  if (!harness) throw new Error("Encrypted backup harness is unavailable.");

  deviceA = await launchAgentControlDevice(harness, "A");
  await authenticateFirstAgentControlDevice(harness, deviceA);
  await claimDefaultProfile(deviceA);
  const version = await publishUserVersion(deviceA);
  const sourceInstallation = unwrap(
    await invokeAgentera(deviceA, "claimVersion", {
      definitionId: version.definitionId,
      versionId: version.versionId,
      localProfileId: "default",
      confirmation: "claim-existing-profile",
    }),
  );
  const sourceProfile = deviceProfilePath(deviceA, "default");
  await seedPrivateProfile(sourceProfile);
  await startBoundConversation(deviceA, "default", SESSION_CANARY);
  await expect
    .poll(async () => (await localAgentControlState(deviceA!)).bindings.length)
    .toBe(1);
  seedSessionDatabase(sourceProfile);
  await expect
    .poll(async () =>
      (await readFile(join(sourceProfile, "state.db"))).includes(
        Buffer.from(SESSION_CANARY),
      ),
    )
    .toBe(true);
  const sourceBefore = await privateProfileSnapshot(
    sourceProfile,
    PROFILE_MARKERS,
  );
  const sourceSessionsBefore = sessionDatabaseSnapshot(sourceProfile);
  const sourceBindingsBefore = (await localAgentControlState(deviceA)).bindings;

  const enrollment =
    await invokeBackup<AgenteraEncryptedBackupPublicEnrollment>(
      deviceA,
      "initializeRecovery",
    );
  expect(enrollment.recoveryPhrase?.split(" ")).toHaveLength(24);
  const recoveryPhrase = enrollment.recoveryPhrase!;
  await invokeBackup<AgenteraEncryptedBackupPublicState>(
    deviceA,
    "confirmRecoverySaved",
  );
  await expect(
    invokeBackup(deviceA, "createBackup", sourceInstallation.id),
  ).rejects.toThrow(/runtime_busy/u);
  await deviceA.page.evaluate(() => window.hermesAPI.abortChat());
  let created: AgenteraEncryptedBackupCreationResult | null = null;
  await expect
    .poll(
      async () => {
        try {
          created = await invokeBackup<AgenteraEncryptedBackupCreationResult>(
            deviceA!,
            "createBackup",
            sourceInstallation.id,
          );
          return "created";
        } catch (error) {
          if (String(error).includes("runtime_busy")) return "runtime_busy";
          throw error;
        }
      },
      { timeout: 120_000, intervals: [250, 500, 1_000] },
    )
    .toBe("created");
  if (created === null) throw new Error("Encrypted backup was not created.");
  const backups = await invokeBackup<AgenteraEncryptedBackupPublicSummary[]>(
    deviceA,
    "listBackups",
  );
  expect(backups.map((backup) => backup.backupId)).toContain(created.backupId);

  const databaseDump = encryptedBackupPostgresDump(harness);
  const cloudObjects = inspectEncryptedBackupObjects(harness, created.backupId);
  expect(cloudObjects.keys.length).toBeGreaterThan(1);
  for (const canary of [
    MEMORY_CANARY,
    USER_CANARY,
    SKILL_CANARY,
    SESSION_CANARY,
    FORBIDDEN_SOURCE_CANARY,
    recoveryPhrase,
  ]) {
    expect(databaseDump).not.toContain(canary);
    expect(cloudObjects.ciphertext.includes(Buffer.from(canary))).toBe(false);
  }
  expect(JSON.stringify(cloudObjects.stats)).not.toMatch(
    /filename|profile|phrase|root.?key|data.?key|memory|session|skill/iu,
  );

  deviceB = await launchAgentControlDevice(harness, "B");
  await authenticateExistingAgentControlDevice(harness, deviceB);
  await waitForRuntime(deviceB);
  const deviceBDefaultBefore = await privateProfileSnapshot(
    deviceProfilePath(deviceB, "default"),
    PROFILE_MARKERS,
  );
  const deviceBState = await invokeBackup<AgenteraEncryptedBackupPublicState>(
    deviceB,
    "getState",
  );
  await invokeBackup<AgenteraEncryptedBackupPublicDevice[]>(
    deviceB,
    "registerCurrentDevice",
  );
  const pendingDevice = (
    await invokeBackup<AgenteraEncryptedBackupPublicDevice[]>(
      deviceA,
      "listDevices",
    )
  ).find((device) => device.deviceId === deviceBState.currentDeviceId);
  expect(pendingDevice).toMatchObject({ authorizationRequired: true });
  await invokeBackup<AgenteraEncryptedBackupPublicDevice[]>(
    deviceA,
    "authorizeDevice",
    pendingDevice!.deviceId,
  );

  const authorizedPreparation =
    await invokeBackup<AgenteraEncryptedBackupPreparedRestore>(
      deviceB,
      "prepareRestore",
      created.backupId,
    );
  const authorizedRestore =
    await invokeBackup<AgenteraEncryptedBackupConfirmedRestore>(
      deviceB,
      "confirmRestore",
      authorizedPreparation.preparationId,
      "Authorized device restore",
    );
  expect(authorizedRestore.agentInstallationId).not.toBe(sourceInstallation.id);
  expect(authorizedRestore.profileId).not.toBe("default");
  const authorizedProfile = deviceProfilePath(
    deviceB,
    authorizedRestore.profileId,
  );
  expect(
    await readFile(join(authorizedProfile, "memories/MEMORY.md"), "utf8"),
  ).toBe(`${MEMORY_CANARY}\n`);
  expect(
    await readFile(join(authorizedProfile, "memories/USER.md"), "utf8"),
  ).toBe(`${USER_CANARY}\n`);
  expect(
    await readFile(
      join(authorizedProfile, "skills/backup-private/SKILL.md"),
      "utf8",
    ),
  ).toContain(SKILL_CANARY);
  expect(sessionDatabaseSnapshot(authorizedProfile)).toEqual(
    sourceSessionsBefore,
  );
  expect(
    await privateProfileSnapshot(
      deviceProfilePath(deviceB, "default"),
      PROFILE_MARKERS,
    ),
  ).toEqual(deviceBDefaultBefore);
  expect(
    (await localAgentControlState(deviceB)).bindings.filter(
      (binding) =>
        binding.agentInstallationId === authorizedRestore.agentInstallationId,
    ),
  ).toEqual([]);
  expect(
    restoreRecordCount(deviceB, authorizedRestore.agentInstallationId),
  ).toBe(1);

  deviceC = await launchAgentControlDevice(harness, "C");
  await authenticateExistingAgentControlDevice(harness, deviceC);
  await waitForRuntime(deviceC);
  const beforeWrongPhrase = await localAgentControlState(deviceC);
  const wrongPhrase = recoveryPhraseFromEntropy(Buffer.alloc(32, 0x73));
  await expect(
    invokeBackup(deviceC, "prepareRestore", created.backupId, wrongPhrase),
  ).rejects.toThrow();
  expect((await localAgentControlState(deviceC)).installations).toEqual(
    beforeWrongPhrase.installations,
  );
  const phrasePreparation =
    await invokeBackup<AgenteraEncryptedBackupPreparedRestore>(
      deviceC,
      "prepareRestore",
      created.backupId,
      recoveryPhrase,
    );
  const phraseRestore =
    await invokeBackup<AgenteraEncryptedBackupConfirmedRestore>(
      deviceC,
      "confirmRestore",
      phrasePreparation.preparationId,
      "Recovery phrase restore",
    );
  const phraseProfile = deviceProfilePath(deviceC, phraseRestore.profileId);
  expect(
    await readFile(join(phraseProfile, "memories/MEMORY.md"), "utf8"),
  ).toBe(`${MEMORY_CANARY}\n`);
  expect(sessionDatabaseSnapshot(phraseProfile)).toEqual(sourceSessionsBefore);
  expect(restoreRecordCount(deviceC, phraseRestore.agentInstallationId)).toBe(
    1,
  );

  failNextEncryptedBackupChunkUpload(harness);
  await expect(
    invokeBackup(deviceA, "createBackup", sourceInstallation.id),
  ).rejects.toThrow();
  expect(
    await invokeBackup<AgenteraEncryptedBackupPublicSummary[]>(
      deviceA,
      "listBackups",
    ),
  ).toHaveLength(1);
  const resumed = await invokeBackup<AgenteraEncryptedBackupCreationResult>(
    deviceA,
    "createBackup",
    sourceInstallation.id,
  );
  expect(resumed.resumed).toBe(true);
  expect(resumed.backupId).not.toBe(created.backupId);

  await invokeBackup<AgenteraEncryptedBackupPublicDevice[]>(
    deviceA,
    "revokeDevice",
    pendingDevice!.deviceId,
  );
  await expect(
    invokeBackup(deviceB, "prepareRestore", resumed.backupId),
  ).rejects.toThrow();

  const phraseProfileBeforeTamper = await privateProfileSnapshot(
    phraseProfile,
    PROFILE_MARKERS,
  );
  const phraseSessionsBeforeTamper = sessionDatabaseSnapshot(phraseProfile);
  tamperEncryptedBackupObject(harness, cloudObjects.keys[0]);
  await expect(
    invokeBackup(deviceC, "prepareRestore", created.backupId, recoveryPhrase),
  ).rejects.toThrow();
  expect(await privateProfileSnapshot(phraseProfile, PROFILE_MARKERS)).toEqual(
    phraseProfileBeforeTamper,
  );
  expect(sessionDatabaseSnapshot(phraseProfile)).toEqual(
    phraseSessionsBeforeTamper,
  );

  stopEncryptedBackupMinIO(harness);
  await expect(
    invokeBackup(deviceA, "deleteBackup", created.backupId),
  ).rejects.toThrow();
  expect(encryptedBackupCloudRecord(harness, created.backupId)).toMatchObject({
    missing: false,
    state: "deleting",
    recoveryEnvelopePresent: false,
    wrappedDataKeyPresent: false,
    activeDeviceEnvelopes: 0,
  });
  startEncryptedBackupMinIO(harness);
  await invokeBackup<void>(deviceA, "deleteBackup", created.backupId);
  expect(encryptedBackupCloudRecord(harness, created.backupId)).toMatchObject({
    missing: false,
    state: "deleted",
    recoveryEnvelopePresent: false,
    wrappedDataKeyPresent: false,
    activeDeviceEnvelopes: 0,
  });
  expect(encryptedBackupObjectCount(harness, created.backupId)).toBe(0);

  expect(await privateProfileSnapshot(sourceProfile, PROFILE_MARKERS)).toEqual(
    sourceBefore,
  );
  expect(sessionDatabaseSnapshot(sourceProfile)).toEqual(sourceSessionsBefore);
  expect((await localAgentControlState(deviceA)).bindings).toEqual(
    sourceBindingsBefore,
  );
  expect(fileDigest(await readFile(join(sourceProfile, ".env")))).toBe(
    fileDigest(Buffer.from(`PRIVATE_TOKEN=${FORBIDDEN_SOURCE_CANARY}\n`)),
  );
  await testInfo.attach("encrypted-backup-staging-coverage", {
    body: JSON.stringify(
      {
        schemaVersion: 1,
        evidenceKind: "isolated_cross_repo_preflight",
        suite: "encrypted_backup_migration",
        scenarios: {
          backupEnablementAndPhraseConfirmation: true,
          backupDeviceEnrollment: true,
          backupManualCreation: true,
          backupResumableUpload: true,
          backupFailureRejections: true,
          backupAuthorizedAndPhraseRestore: true,
          backupCryptographicDeletion: true,
          backupFreshProfileRestore: true,
          noPrivateMarkerInCloud: true,
          sourceProfileUnchanged: true,
        },
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
