import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  persistRuntimeSelection,
  readRuntimeSelection,
} from "../src/main/agentera-runtime-distribution/selection-store";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentera-runtime-selection-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("explicit Runtime target selection", () => {
  it("persists managed mode before a fresh Hermes data home exists", () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "not-created-yet");
    const selectionFile = join(root, "hermes-home.json");

    persistRuntimeSelection(selectionFile, {
      mode: "managed",
      hermesHome,
    });

    expect(readRuntimeSelection(selectionFile)).toEqual({
      mode: "managed",
      hermesHome,
    });
  });

  it("adopts an existing checkout only as an unmanaged external Runtime", () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const checkout = join(hermesHome, "hermes-agent");
    const selectionFile = join(root, "hermes-home.json");
    mkdirSync(checkout, { recursive: true });
    const marker = join(checkout, "local-learning.txt");
    writeFileSync(marker, "external state\n");

    persistRuntimeSelection(selectionFile, {
      mode: "external",
      hermesHome,
    });

    expect(readRuntimeSelection(selectionFile)).toEqual({
      mode: "external",
      hermesHome,
    });
    expect(readFileSync(marker, "utf8")).toBe("external state\n");
  });

  it("switches the selected mode without deleting the external checkout", () => {
    const root = temporaryRoot();
    const hermesHome = join(root, "hermes-home");
    const checkout = join(hermesHome, "hermes-agent");
    const selectionFile = join(root, "hermes-home.json");
    mkdirSync(checkout, { recursive: true });
    const marker = join(checkout, "MEMORY.md");
    writeFileSync(marker, "self-learning state\n");

    persistRuntimeSelection(selectionFile, {
      mode: "external",
      hermesHome,
    });
    persistRuntimeSelection(selectionFile, {
      mode: "managed",
      hermesHome,
    });

    expect(readRuntimeSelection(selectionFile)).toEqual({
      mode: "managed",
      hermesHome,
    });
    expect(readFileSync(marker, "utf8")).toBe("self-learning state\n");
  });
});
