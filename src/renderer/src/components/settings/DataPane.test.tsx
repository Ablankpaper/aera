import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DataPane from "./DataPane";
import type { AgenteraAgentInstallationSummary } from "../../../../shared/agentera-agent-control";
import type {
  AgenteraEncryptedBackupProgress,
  AgenteraEncryptedBackupPublicSummary,
  AgenteraEncryptedBackupPublicState,
} from "../../../../shared/agentera-encrypted-backup";

const INSTALLATION_ID = "40000000-0000-4000-8000-000000000001";
const BACKUP_ID = "70000000-0000-4000-8000-000000000001";
const CURRENT_DEVICE_ID = "20000000-0000-4000-8000-000000000001";
const PENDING_DEVICE_ID = "20000000-0000-4000-8000-000000000002";
const AUTHORIZED_DEVICE_ID = "20000000-0000-4000-8000-000000000003";
const PREPARATION_ID = "80000000-0000-4000-8000-000000000001";
const RECOVERY_PHRASE = Array.from(
  { length: 24 },
  (_, index) => `word${index + 1}`,
).join(" ");

const settings = vi.hoisted(() => ({
  backingUp: false,
  backupResult: "",
  importing: false,
  importResult: "",
  handleBackup: vi.fn(),
  handleImport: vi.fn(),
  openclawFound: false,
  openclawPath: "",
  migrationDismissed: false,
  migrating: false,
  migrationLog: "",
  migrationResult: "",
  migrationResultType: "",
  migrationLogRef: { current: null },
  handleMigrate: vi.fn(),
  handleDismissMigration: vi.fn(),
}));

vi.mock("./SettingsDataContext", () => ({
  useSettings: () => settings,
}));

vi.mock("../useI18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string, options?: Record<string, unknown>): string =>
      [key, options?.id, options?.percent].filter(Boolean).join(" "),
  }),
}));

function publicState(
  overrides: Partial<AgenteraEncryptedBackupPublicState> = {},
): AgenteraEncryptedBackupPublicState {
  return {
    available: true,
    initialized: true,
    recoveryConfirmed: true,
    currentDeviceId: CURRENT_DEVICE_ID,
    keyEpoch: 1,
    profileLineageId: "30000000-0000-4000-8000-000000000001",
    scheduledInstallationIds: [],
    activeBackups: [],
    ...overrides,
  };
}

function installation(): AgenteraAgentInstallationSummary {
  return {
    id: INSTALLATION_ID,
    sourceScope: "USER" as const,
    officialReleaseId: null,
    selectedReleaseRevisionId: null,
    updatePolicy: "manual" as const,
    definitionId: "50000000-0000-4000-8000-000000000001",
    selectedVersionId: "60000000-0000-4000-8000-000000000001",
    runtimeProfileId: "90000000-0000-4000-8000-000000000001",
    policySnapshotId: null,
    status: "active" as const,
    retryCode: null,
    createdAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:00.000Z",
  };
}

function backup(): AgenteraEncryptedBackupPublicSummary {
  return {
    backupId: BACKUP_ID,
    profileLineageId: "30000000-0000-4000-8000-000000000001",
    sourceInstallationId: INSTALLATION_ID,
    sourceDefinitionId: "50000000-0000-4000-8000-000000000001",
    sourceVersionId: "60000000-0000-4000-8000-000000000001",
    parentBackupId: null,
    sourceDeviceId: CURRENT_DEVICE_ID,
    keyEpoch: 1,
    chunkCount: 2,
    totalCiphertextSize: 128,
    createdAt: "2026-07-23T12:00:00.000Z",
    sealedAt: "2026-07-23T12:01:00.000Z",
  };
}

describe("DataPane encrypted backup", () => {
  const getState = vi.fn();
  const initializeRecovery = vi.fn();
  const confirmRecoverySaved = vi.fn();
  const registerCurrentDevice = vi.fn();
  const authorizeDevice = vi.fn();
  const createBackup = vi.fn();
  const cancelBackup = vi.fn();
  const listBackups = vi.fn();
  const deleteBackup = vi.fn();
  const setDailySchedule = vi.fn();
  const listDevices = vi.fn();
  const revokeDevice = vi.fn();
  const prepareRestore = vi.fn();
  const confirmRestore = vi.fn();
  const cancelRestore = vi.fn();
  let progressListener:
    | ((progress: AgenteraEncryptedBackupProgress[]) => void)
    | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    progressListener = null;
    getState.mockResolvedValue(publicState());
    initializeRecovery.mockResolvedValue({
      state: publicState({ recoveryConfirmed: false }),
      recoveryPhrase: RECOVERY_PHRASE,
    });
    confirmRecoverySaved.mockResolvedValue(publicState());
    registerCurrentDevice.mockResolvedValue([]);
    authorizeDevice.mockResolvedValue([]);
    createBackup.mockResolvedValue({
      backupId: BACKUP_ID,
      sealedAt: "2026-07-23T12:01:00.000Z",
      resumed: false,
      deviceEnvelopeSyncPending: false,
    });
    cancelBackup.mockResolvedValue(true);
    listBackups.mockResolvedValue([]);
    deleteBackup.mockResolvedValue(undefined);
    setDailySchedule.mockImplementation(async (_id, enabled) =>
      publicState({
        scheduledInstallationIds: enabled ? [INSTALLATION_ID] : [],
      }),
    );
    listDevices.mockResolvedValue([]);
    revokeDevice.mockResolvedValue([]);
    prepareRestore.mockResolvedValue({
      preparationId: PREPARATION_ID,
      backupId: BACKUP_ID,
      sourceInstallationId: INSTALLATION_ID,
      sourceDefinitionId: "50000000-0000-4000-8000-000000000001",
      sourceVersionId: "60000000-0000-4000-8000-000000000001",
      createdAt: "2026-07-23T12:00:00.000Z",
      fileCount: 4,
      totalPlaintextSize: 512,
    });
    confirmRestore.mockResolvedValue({
      backupId: BACKUP_ID,
      agentInstallationId: "40000000-0000-4000-8000-000000000004",
      profileId: "90000000-0000-4000-8000-000000000004",
      runtimeProfileId: "90000000-0000-4000-8000-000000000005",
    });
    cancelRestore.mockResolvedValue(true);

    Object.defineProperty(window, "agenteraAgents", {
      configurable: true,
      value: {
        listInstallations: vi.fn(async () => ({
          ok: true as const,
          data: [installation()],
        })),
      },
    });
    Object.defineProperty(window, "agenteraEncryptedBackup", {
      configurable: true,
      value: {
        getState,
        initializeRecovery,
        confirmRecoverySaved,
        registerCurrentDevice,
        authorizeDevice,
        createBackup,
        cancelBackup,
        listBackups,
        deleteBackup,
        setDailySchedule,
        listDevices,
        revokeDevice,
        prepareRestore,
        confirmRestore,
        cancelRestore,
        onProgress: vi.fn((listener) => {
          progressListener = listener;
          return () => {
            progressListener = null;
          };
        }),
      },
    });
  });

  it("shows the recovery phrase once, requires written-down confirmation, and offers no clipboard action", async () => {
    getState.mockResolvedValueOnce(
      publicState({
        initialized: false,
        recoveryConfirmed: false,
        keyEpoch: null,
        profileLineageId: null,
      }),
    );
    render(<DataPane />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "settings.encryptedBackup.setup",
      }),
    );

    expect(
      await screen.findByRole("dialog", {
        name: "settings.encryptedBackup.recoveryTitle",
      }),
    ).toHaveTextContent(RECOVERY_PHRASE);
    expect(
      screen.queryByRole("button", {
        name: /settings\.encryptedBackup\.copy/i,
      }),
    ).not.toBeInTheDocument();

    const confirm = screen.getByRole("button", {
      name: "settings.encryptedBackup.confirmRecovery",
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "settings.encryptedBackup.confirmWritten",
      }),
    );
    fireEvent.click(confirm);

    await waitFor(() => expect(confirmRecoverySaved).toHaveBeenCalledOnce());
    expect(screen.queryByText(RECOVERY_PHRASE)).not.toBeInTheDocument();
  });

  it("surfaces manual progress, supports cancellation, and renders quota failures", async () => {
    createBackup.mockRejectedValueOnce(
      Object.assign(new Error("quota"), { code: "quota_exceeded" }),
    );
    render(<DataPane />);

    const backupButton = await screen.findByRole("button", {
      name: "settings.encryptedBackup.backupNow",
    });
    fireEvent.click(backupButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "settings.encryptedBackup.quotaExceeded",
    );

    act(() => {
      progressListener?.([
        {
          installationId: INSTALLATION_ID,
          phase: "uploading",
          uploadedObjects: 2,
          totalObjects: 4,
        },
      ]);
    });
    expect(
      screen.getByText("settings.encryptedBackup.progress 50"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.encryptedBackup.cancelBackup",
      }),
    );
    await waitFor(() =>
      expect(cancelBackup).toHaveBeenCalledWith(INSTALLATION_ID),
    );
  });

  it("requires warnings before device authorization, revocation, and backup deletion", async () => {
    listBackups.mockResolvedValue([backup()]);
    const deviceList = [
      {
        deviceId: CURRENT_DEVICE_ID,
        keyEpoch: 1,
        revision: 1,
        status: "active",
        isCurrent: true,
        authorized: true,
        authorizationRequired: false,
        registeredAt: "2026-07-23T12:00:00.000Z",
        revokedAt: null,
      },
      {
        deviceId: PENDING_DEVICE_ID,
        keyEpoch: 1,
        revision: 1,
        status: "active",
        isCurrent: false,
        authorized: false,
        authorizationRequired: true,
        registeredAt: "2026-07-23T12:00:00.000Z",
        revokedAt: null,
      },
      {
        deviceId: AUTHORIZED_DEVICE_ID,
        keyEpoch: 1,
        revision: 1,
        status: "active",
        isCurrent: false,
        authorized: true,
        authorizationRequired: false,
        registeredAt: "2026-07-23T12:00:00.000Z",
        revokedAt: null,
      },
    ];
    listDevices.mockResolvedValue(deviceList);
    authorizeDevice.mockResolvedValue(deviceList);
    revokeDevice.mockResolvedValue(deviceList);
    render(<DataPane />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: `settings.encryptedBackup.authorizeDevice ${PENDING_DEVICE_ID}`,
      }),
    );
    expect(
      screen.getByText("settings.encryptedBackup.authorizeWarning"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.encryptedBackup.confirmAuthorize",
      }),
    );
    await waitFor(() =>
      expect(authorizeDevice).toHaveBeenCalledWith(PENDING_DEVICE_ID),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `settings.encryptedBackup.revokeDevice ${AUTHORIZED_DEVICE_ID}`,
      }),
    );
    expect(
      screen.getByText("settings.encryptedBackup.revokeWarning"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.encryptedBackup.confirmRevoke",
      }),
    );
    await waitFor(() =>
      expect(revokeDevice).toHaveBeenCalledWith(AUTHORIZED_DEVICE_ID),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `settings.encryptedBackup.deleteBackup ${BACKUP_ID}`,
      }),
    );
    expect(
      screen.getByText("settings.encryptedBackup.deleteWarning"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.encryptedBackup.confirmDelete",
      }),
    );
    await waitFor(() => expect(deleteBackup).toHaveBeenCalledWith(BACKUP_ID));
  });

  it("prepares a restore and requires a name plus fresh-Profile confirmation", async () => {
    listBackups.mockResolvedValue([backup()]);
    render(<DataPane />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: `settings.encryptedBackup.restore ${BACKUP_ID}`,
      }),
    );
    expect(
      screen.getByText("settings.encryptedBackup.restoreFreshWarning"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/destination|path|folder/i),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.encryptedBackup.prepareRestore",
      }),
    );
    await waitFor(() =>
      expect(prepareRestore).toHaveBeenCalledWith(BACKUP_ID, undefined),
    );

    const name = await screen.findByLabelText(
      "settings.encryptedBackup.restoreName",
    );
    fireEvent.change(name, { target: { value: "Migrated profile" } });
    const confirm = screen.getByRole("button", {
      name: "settings.encryptedBackup.confirmRestore",
    });
    expect(confirm).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "settings.encryptedBackup.confirmFreshProfile",
      }),
    );
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(confirmRestore).toHaveBeenCalledWith(
        PREPARATION_ID,
        "Migrated profile",
      ),
    );
  });
});
