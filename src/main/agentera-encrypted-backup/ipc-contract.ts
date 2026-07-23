import { recoveryEntropyFromPhrase } from "./crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(): never {
  throw Object.assign(new Error("Invalid encrypted backup request."), {
    code: "invalid_request",
  });
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid();
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((field) => Object.hasOwn(record, field)) ||
    Object.keys(record).some((field) => !allowed.has(field))
  ) {
    invalid();
  }
  return record;
}

function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID_PATTERN.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    invalid();
  }
  return value;
}

function confirmation<T extends string>(value: unknown, expected: T): T {
  if (value !== expected) invalid();
  return expected;
}

function hasUnsafeProfileNameCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      character === "/" ||
      character === "\\"
    );
  });
}

function safeProfileName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    Array.from(value).length < 1 ||
    Array.from(value).length > 80 ||
    hasUnsafeProfileNameCharacter(value) ||
    value === "." ||
    value === ".."
  ) {
    invalid();
  }
  return value;
}

export function parseInitializeEncryptedBackupRecoveryInput(value: unknown): {
  confirmation: "initialize-recovery";
} {
  const input = exactObject(value, ["confirmation"]);
  return {
    confirmation: confirmation(input.confirmation, "initialize-recovery"),
  };
}

export function parseConfirmEncryptedBackupRecoveryInput(value: unknown): {
  confirmation: "recovery-written-down";
} {
  const input = exactObject(value, ["confirmation"]);
  return {
    confirmation: confirmation(input.confirmation, "recovery-written-down"),
  };
}

export function parseRegisterEncryptedBackupDeviceInput(value: unknown): {
  confirmation: "register-current-device";
} {
  const input = exactObject(value, ["confirmation"]);
  return {
    confirmation: confirmation(input.confirmation, "register-current-device"),
  };
}

export function parseAuthorizeEncryptedBackupDeviceInput(value: unknown): {
  deviceId: string;
  confirmation: "authorize-device";
} {
  const input = exactObject(value, ["deviceId", "confirmation"]);
  return {
    deviceId: uuid(input.deviceId),
    confirmation: confirmation(input.confirmation, "authorize-device"),
  };
}

export function parseCreateEncryptedBackupInput(value: unknown): {
  installationId: string;
} {
  const input = exactObject(value, ["installationId"]);
  return { installationId: uuid(input.installationId) };
}

export const parseCancelEncryptedBackupInput = parseCreateEncryptedBackupInput;

export function parseSetEncryptedBackupScheduleInput(value: unknown): {
  installationId: string;
  enabled: boolean;
} {
  const input = exactObject(value, ["installationId", "enabled"]);
  if (typeof input.enabled !== "boolean") invalid();
  return {
    installationId: uuid(input.installationId),
    enabled: input.enabled,
  };
}

export function parseDeleteEncryptedBackupInput(value: unknown): {
  backupId: string;
  confirmation: "delete-backup";
} {
  const input = exactObject(value, ["backupId", "confirmation"]);
  return {
    backupId: uuid(input.backupId),
    confirmation: confirmation(input.confirmation, "delete-backup"),
  };
}

export function parseRevokeEncryptedBackupDeviceInput(value: unknown): {
  deviceId: string;
  confirmation: "revoke-device";
} {
  const input = exactObject(value, ["deviceId", "confirmation"]);
  return {
    deviceId: uuid(input.deviceId),
    confirmation: confirmation(input.confirmation, "revoke-device"),
  };
}

export function parsePrepareEncryptedBackupRestoreInput(value: unknown): {
  backupId: string;
  recoveryPhrase?: string;
} {
  const input = exactObject(value, ["backupId"], ["recoveryPhrase"]);
  if (input.recoveryPhrase === undefined) {
    return { backupId: uuid(input.backupId) };
  }
  if (typeof input.recoveryPhrase !== "string") invalid();
  let entropy: Uint8Array | null = null;
  try {
    entropy = recoveryEntropyFromPhrase(input.recoveryPhrase);
  } catch {
    invalid();
  } finally {
    entropy?.fill(0);
  }
  return {
    backupId: uuid(input.backupId),
    recoveryPhrase: input.recoveryPhrase,
  };
}

export function parseConfirmEncryptedBackupRestoreInput(value: unknown): {
  preparationId: string;
  name: string;
  confirmation: "restore-into-new-profile";
} {
  const input = exactObject(value, ["preparationId", "name", "confirmation"]);
  return {
    preparationId: uuid(input.preparationId),
    name: safeProfileName(input.name),
    confirmation: confirmation(input.confirmation, "restore-into-new-profile"),
  };
}

export function parseCancelEncryptedBackupRestoreInput(value: unknown): {
  preparationId: string;
} {
  const input = exactObject(value, ["preparationId"]);
  return { preparationId: uuid(input.preparationId) };
}
