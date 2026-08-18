import { safeWriteFile } from "./utils";
import {
  assertManagedWritePath,
  clearManagedModelFileRoots,
  currentModelConfigurationWritePermit,
  managedModelFileLocation,
  registerManagedModelFileRoots,
  type ModelConfigurationWritePermit,
} from "./model-configuration-write-authority";

export type {
  ManagedModelFileRole,
  ManagedModelFileRoots,
  ModelConfigurationWritePermit,
} from "./model-configuration-write-authority";
export {
  clearManagedModelFileRoots,
  managedModelFileLocation,
  registerManagedModelFileRoots,
};

export function writeManagedModelFile(
  permit: ModelConfigurationWritePermit | null | undefined,
  target: string,
  bytes: string | Uint8Array,
  mode?: number,
): void {
  if (!managedModelFileLocation(target)) {
    throw new Error("Target is not a registered managed model file.");
  }
  assertManagedWritePath(target, permit ?? currentModelConfigurationWritePermit());
  safeWriteFile(target, bytes, mode);
}
