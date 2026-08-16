"use strict";

const { mkdir } = require("node:fs/promises");
const { isAbsolute, resolve } = require("node:path");
const { app } = require("electron");

const SUCCESS_MARKER = "AERA_PACKAGED_UPDATER_EXTRACTION_OK";

function requiredPath(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

async function run() {
  const updaterEntry = requiredPath("AERA_PACKAGED_UPDATER_ENTRY");
  const archive = requiredPath("AERA_PACKAGED_UPDATER_ARCHIVE");
  const staging = requiredPath("AERA_PACKAGED_UPDATER_STAGING");
  const userData = requiredPath("AERA_PACKAGED_UPDATER_USER_DATA");

  app.commandLine.appendSwitch("disable-gpu");
  app.setPath("userData", userData);
  await Promise.all([
    mkdir(staging, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  await app.whenReady();

  const updater = require(updaterEntry);
  if (typeof updater.extractDesktopUpdateZip !== "function") {
    throw new Error("packaged extractDesktopUpdateZip export is unavailable");
  }
  const previousNoAsar = process.noAsar;
  await updater.extractDesktopUpdateZip(archive, staging);
  if (process.noAsar !== previousNoAsar) {
    throw new Error("packaged extractor did not restore process.noAsar");
  }
  process.stdout.write(`${SUCCESS_MARKER}\n`);
}

run().then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(
      `Packaged updater extraction probe failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    app.exit(1);
  },
);
