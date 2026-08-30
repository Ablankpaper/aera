// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const observerPath = join(ROOT, "tests/e2e/agentera-runtime-contract.e2e.ts");
const observerSourceText = readFileSync(observerPath, "utf8");
const observerSource = ts.createSourceFile(
  observerPath,
  observerSourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function functionDeclaration(name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(observerSource);
  if (found === null) throw new Error(`missing function: ${name}`);
  return found;
}

describe("packaged Runtime contract observer boundaries", () => {
  it("supports an explicit observer-off diagnostic mode", () => {
    expect(observerSourceText).toContain("shouldStartGatewayLaunchObserver");
    expect(observerSourceText).toContain("AGENTERA_E2E_GATEWAY_OBSERVER");
    expect(observerSourceText).toContain("gateway-external-observer-disabled");
    const launch = observerSourceText.indexOf(
      "gatewayLaunchObserver = startGatewayLaunchObserver",
    );
    const guard = observerSourceText.indexOf(
      "if (shouldStartGatewayLaunchObserver())",
    );
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(launch).toBeGreaterThan(guard);
  });

  it("keeps Runtime installation at the Profile-stage-only observer mode", () => {
    const source = functionDeclaration("startRuntimeInstallObserver").getText(
      observerSource,
    );
    expect(source).toContain('processSnapshot: "disabled"');
    expect(source).not.toContain('processSnapshot: "enabled"');
  });

  it("keeps Gateway launch diagnostics enabled for external process snapshots", () => {
    const source = functionDeclaration("startGatewayLaunchObserver").getText(
      observerSource,
    );
    expect(source).toContain('processSnapshot: "enabled"');
  });

  it("returns before the Windows process-table query in the disabled mode", () => {
    const source = functionDeclaration("startLaunchObserver").getText(
      observerSource,
    );
    const disabledGuard = source.indexOf(
      'if (options.processSnapshot === "disabled")',
    );
    const processQuery = source.indexOf("queryWindowsRuntimeProcesses(");
    expect(disabledGuard).toBeGreaterThanOrEqual(0);
    expect(processQuery).toBeGreaterThan(disabledGuard);
    expect(source.slice(disabledGuard, processQuery)).toContain("return;");
  });
});
