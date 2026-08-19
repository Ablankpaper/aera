/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createDiagnosticSessionFixture(root) {
  const app = join(root, "Aera-fixture");
  const logs = join(root, "logs");
  mkdirSync(app, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const events = [
    { family: "main", event: "main_loaded", diagnosticId: "000000000001" },
    {
      family: "owner",
      event: "owner_transition_started",
      transitionId: "000000000002",
    },
    {
      family: "model_configuration",
      event: "model_configuration_rolled_back",
      diagnosticId: "000000000003",
    },
    { family: "runtime", event: "runtime_ready", diagnosticId: "000000000004" },
    {
      family: "updater",
      event: "updater_health_marked",
      operationId: "000000000005",
    },
  ];
  writeFileSync(
    join(logs, "stable-events.json"),
    `${JSON.stringify(events)}\n`,
    "utf8",
  );
  return {
    schemaVersion: 1,
    version: "0.7.4-internal-beta.33",
    app,
    logs,
    events,
  };
}
