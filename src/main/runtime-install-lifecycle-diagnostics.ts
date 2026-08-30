import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import type { PackagedSeedInstallDiagnostic } from "./agentera-runtime-distribution/seed-installer";

const DIAGNOSTIC_OUTPUT = "AGENTERA_E2E_RUNTIME_CONTRACT_DIAGNOSTIC_OUTPUT";
const RUNTIME_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;

function safeDiagnosticFields(
  fields: Readonly<Record<string, boolean | number | string | null>>,
): Readonly<Record<string, number | string>> {
  const safe: Record<string, number | string> = {};
  if (
    typeof fields.runtimeVersion === "string" &&
    RUNTIME_VERSION_PATTERN.test(fields.runtimeVersion)
  ) {
    safe.runtimeVersion = fields.runtimeVersion;
  }
  if (
    typeof fields.requiredDiskBytes === "number" &&
    Number.isSafeInteger(fields.requiredDiskBytes) &&
    fields.requiredDiskBytes >= 0
  ) {
    safe.requiredDiskBytes = fields.requiredDiskBytes;
  }
  return safe;
}

/**
 * Bind the packaged Seed installer to the acceptance JSONL timeline only
 * under explicit diagnostics. The returned observer records no paths,
 * credentials, environment values, or raw exceptions.
 */
// @lat: [[agentera-runtime-distribution#Release gate#Packaged live Runtime contract#Packaged install transaction lifecycle evidence]]
export function createPackagedSeedInstallDiagnostic():
  | PackagedSeedInstallDiagnostic
  | undefined {
  if (process.env.AGENTERA_E2E_DIAGNOSTICS !== "1") return undefined;
  const output = process.env[DIAGNOSTIC_OUTPUT]?.trim();
  if (!output || !isAbsolute(output)) return undefined;
  const startedAt = performance.now();

  return (event, fields = {}) => {
    try {
      appendFileSync(
        output,
        `${JSON.stringify({
          schemaVersion: 1,
          event: `runtime-install-${event}`,
          elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
          ...safeDiagnosticFields(fields),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Diagnostic evidence must never change Runtime installation behavior.
    }
  };
}
