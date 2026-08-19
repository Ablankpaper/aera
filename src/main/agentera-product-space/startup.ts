import type { AgenteraProductSpaceDatabase } from "./db";
import type { AgenteraProductSpaceManager } from "./manager";

export type AgenteraProductSpaceStartupStage =
  | "database"
  | "manager"
  | "attachment";

export interface AgenteraProductSpaceStartupResources {
  manager: Pick<AgenteraProductSpaceManager, "close"> | null;
  database: Pick<AgenteraProductSpaceDatabase, "close"> | null;
}

/**
 * Dispose partially-created Product Space resources without allowing cleanup
 * to turn a best-effort startup degradation into a second startup failure.
 * A manager owns the database after construction; the database is closed
 * directly only when construction never produced a manager.
 */
export function closeAgenteraProductSpaceStartupResources(
  resources: AgenteraProductSpaceStartupResources,
): void {
  if (resources.manager) {
    try {
      resources.manager.close();
    } catch {
      // A failed close must not prevent the fallback database close below.
      try {
        resources.database?.close();
      } catch {
        // Preserve the original startup failure.
      }
    }
    return;
  }
  try {
    resources.database?.close();
  } catch {
    // Preserve the original startup failure.
  }
}

export function stableProductSpaceStartupCause(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(code)) {
      return code;
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(name)) {
      return name.toLowerCase();
    }
  }
  return "initialization_failed";
}

export function logAgenteraProductSpaceUnavailable(
  stage: AgenteraProductSpaceStartupStage,
  error: unknown,
  log: (message: string) => void = console.error,
): void {
  log(
    `[AGENTERA_PRODUCT_SPACE] unavailable stage=${stage} cause=${stableProductSpaceStartupCause(error)}`,
  );
}
