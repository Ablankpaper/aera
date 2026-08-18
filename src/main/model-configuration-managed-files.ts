import { safeWriteFile } from "./utils";
import {
  assertManagedWritePath,
  clearManagedModelFileRoots,
  currentManagedModelProfileRoot,
  currentModelConfigurationWritePermit,
  managedModelFileLocation,
  registerManagedModelProfileRoot,
  registerManagedModelFileRoots,
  runWithManagedModelProfileRoot,
  unregisterManagedModelProfileRoot,
  type ModelConfigurationWritePermit,
} from "./model-configuration-write-authority";

export type {
  ManagedModelFileRole,
  ManagedModelFileRoots,
  ModelConfigurationWritePermit,
} from "./model-configuration-write-authority";
export {
  clearManagedModelFileRoots,
  currentManagedModelProfileRoot,
  currentModelConfigurationWritePermit,
  managedModelFileLocation,
  registerManagedModelProfileRoot,
  registerManagedModelFileRoots,
  runWithManagedModelProfileRoot,
  unregisterManagedModelProfileRoot,
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
  assertManagedWritePath(target, permit ?? null);
  safeWriteFile(target, bytes, mode);
}
