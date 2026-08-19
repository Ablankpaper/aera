#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalDiagnosticJson } from "../../deliveries/beta33-external-diagnostic/aera-diagnostic-schema.mjs";
import { inspectTargetIdentity } from "../../deliveries/beta33-external-diagnostic/aera-diagnostic-target.mjs";

export function main(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value == null)
      throw new Error("identity options must be flag/value pairs");
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.app || !values.platform || !values.output)
    throw new Error("--app, --platform and --output are required");
  const inspected = inspectTargetIdentity({
    appPath: resolve(values.app),
    platform: values.platform,
    version: values.version || null,
    applicationId: values.application_id || null,
  });
  const identity = {
    platform: inspected.platform,
    version: inspected.version,
    ...(inspected.bundleId ? { bundleId: inspected.bundleId } : {}),
    ...(inspected.applicationId
      ? { applicationId: inspected.applicationId }
      : {}),
    architecture: inspected.architecture,
    executableSha256: inspected.executableSha256,
    packageSha256: inspected.packageSha256,
  };
  writeFileSync(
    resolve(values.output),
    `${canonicalDiagnosticJson(identity)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.message || "identity inspection failed");
    process.exitCode = 1;
  }
}
