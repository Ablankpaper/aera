import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type RuntimeSelectionMode = "managed" | "external";

export interface PersistedRuntimeSelection {
  mode: RuntimeSelectionMode;
  hermesHome: string;
}

function validHermesHomePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

function validExternalHermesHome(value: unknown): value is string {
  if (!validHermesHomePath(value)) return false;
  try {
    const metadata = lstatSync(value);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

// @lat: [[agentera-runtime-distribution#Explicit external compatibility]]
/** Read the v1 selection record and migrate the legacy `{ hermesHome }` shape. */
export function readRuntimeSelection(
  file: string,
): PersistedRuntimeSelection | null {
  if (!file || !existsSync(file)) return null;
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      value.schemaVersion === undefined &&
      value.mode === undefined &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, "hermesHome") &&
      validExternalHermesHome(value.hermesHome)
    ) {
      return { mode: "external", hermesHome: resolve(value.hermesHome) };
    }
    if (
      value.schemaVersion !== 1 ||
      (value.mode !== "managed" && value.mode !== "external") ||
      Object.keys(value).some(
        (key) => !["schemaVersion", "mode", "hermesHome"].includes(key),
      ) ||
      !validHermesHomePath(value.hermesHome) ||
      (value.mode === "external" && !validExternalHermesHome(value.hermesHome))
    ) {
      return null;
    }
    return { mode: value.mode, hermesHome: resolve(value.hermesHome) };
  } catch {
    return null;
  }
}

export function persistRuntimeSelection(
  file: string,
  selection: PersistedRuntimeSelection,
): void {
  if (selection.mode !== "managed" && selection.mode !== "external") {
    throw new Error("Runtime selection mode is invalid");
  }
  if (
    !file ||
    !validHermesHomePath(selection.hermesHome) ||
    (selection.mode === "external" &&
      !validExternalHermesHome(selection.hermesHome))
  ) {
    throw new Error("Runtime selection Hermes home is invalid");
  }
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  let descriptor: number | null = null;
  try {
    if (existsSync(temporary)) unlinkSync(temporary);
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          mode: selection.mode,
          hermesHome: resolve(selection.hermesHome),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      renameSync(temporary, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      // Windows can reject replacing an existing file. Keep the normal path
      // atomic and use the smallest compatibility fallback only when needed.
      if (existsSync(file)) unlinkSync(file);
      renameSync(temporary, file);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
