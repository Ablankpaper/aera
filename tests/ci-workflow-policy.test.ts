import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  environment?: unknown;
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, Record<string, unknown>>;
    };
  };
  jobs?: Record<string, WorkflowJob>;
}

function readWorkflow(): WorkflowDocument {
  const raw = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  return parseYaml(raw) as WorkflowDocument;
}

function unitTestSteps(): WorkflowStep[] {
  return (readWorkflow().jobs?.check?.steps ?? []).filter((step) =>
    step.name?.startsWith("Test unit"),
  );
}

describe("CI workflow policy", () => {
  // @lat: [[agentera-post-official-delivery#Production readiness and release#Remote CI safety checkpoint]]
  it("uses one explicit unit-test worker policy per platform", () => {
    expect(unitTestSteps()).toEqual([
      {
        name: "Test unit (macOS parallel)",
        if: "matrix.os == 'macos-latest'",
        run: "npm test -- --maxWorkers=2",
      },
      {
        name: "Test unit (Ubuntu serial)",
        if: "matrix.os == 'ubuntu-latest'",
        run: "npm test -- --maxWorkers=1",
      },
      {
        name: "Test unit (Windows serial)",
        if: "matrix.os == 'windows-latest'",
        run: "npm test -- --maxWorkers=1 --testTimeout=20000",
      },
    ]);
  });

  // @lat: [[agentera-post-official-delivery#Production readiness and release#Remote CI safety checkpoint]]
  it("isolates the focused Windows diagnostic from release CI", () => {
    const workflow = readWorkflow();

    expect(workflow.on?.workflow_dispatch?.inputs?.mode).toEqual({
      description: "Execution mode",
      required: true,
      default: "full",
      type: "choice",
      options: [
        "full",
        "windows-process-tree-diagnostic",
        "windows-managed-gateway-diagnostic",
        "windows-runtime-health-diagnostic",
        "windows-packaged-acceptance",
      ],
    });
    expect(workflow.jobs?.check?.if).toBe(
      "github.event_name != 'workflow_dispatch' || inputs.mode == 'full'",
    );

    const diagnostic = workflow.jobs?.["windows-process-tree-diagnostic"];
    expect(diagnostic).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.mode == 'windows-process-tree-diagnostic'",
      name: "windows-process-tree-diagnostic",
      "runs-on": "windows-latest",
      "timeout-minutes": 10,
      env: { AERA_PROCESS_TREE_DIAGNOSTICS: "1" },
    });
    expect(diagnostic?.environment).toBeUndefined();
    expect(diagnostic?.steps).toEqual([
      {
        name: "Checkout",
        uses: "actions/checkout@v4",
      },
      {
        name: "Set up Node",
        uses: "actions/setup-node@v4",
        with: {
          "node-version": 22,
          cache: "npm",
        },
      },
      {
        name: "Install dependencies",
        run: "npm ci",
      },
      {
        name: "Typecheck Node",
        run: "npm run typecheck:node",
      },
      {
        name: "Test Windows process-tree boundary",
        run: "npm test -- src/main/process-tree.test.ts tests/gateway-restart.test.ts src/main/tui-gateway-lifecycle.test.ts src/main/gateway-shutdown-lifecycle.test.ts --maxWorkers=1 --testTimeout=20000 --reporter=verbose",
      },
    ]);

    const managedGateway =
      workflow.jobs?.["windows-managed-gateway-diagnostic"];
    expect(managedGateway).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.mode == 'windows-managed-gateway-diagnostic'",
      name: "windows-managed-gateway-diagnostic",
      "runs-on": "windows-2025",
    });
    // Dispatch-only and credential-free: no environment, no secrets, and no
    // release/deploy steps can follow from a diagnostic run.
    expect(managedGateway?.environment).toBeUndefined();
    expect(JSON.stringify(managedGateway?.steps)).not.toContain("secrets.");
    expect(
      managedGateway?.steps?.some(
        (step) =>
          step.name === "Diagnose the managed Gateway launch path" &&
          step.run?.includes("scripts/diagnose-windows-serve-help.mjs") ===
            true,
      ),
    ).toBe(true);
    expect(
      managedGateway?.steps?.some(
        (step) =>
          step.name === "Upload managed Gateway diagnostic evidence" &&
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.name ===
            "windows-managed-gateway-diagnostic-${{ github.run_id }}",
      ),
    ).toBe(true);

    const managedGatewayRuns = (managedGateway?.steps ?? [])
      .filter((step) => typeof step.run === "string")
      .map((step) => step.run as string);
    expect(
      managedGatewayRuns.some(
        (run) =>
          run.includes("--launch-mode direct") &&
          run.includes("--home-mode candidate") &&
          run.includes("direct-candidate-home-diagnostic.jsonl"),
      ),
    ).toBe(true);
    expect(
      managedGatewayRuns.some(
        (run) =>
          run.includes("--launch-mode direct") &&
          run.includes("--home-mode fake") &&
          run.includes("direct-fake-home-diagnostic.jsonl"),
      ),
    ).toBe(true);
    expect(
      managedGatewayRuns.some(
        (run) =>
          run.includes("--launch-mode instrumented") &&
          run.includes("--home-mode candidate") &&
          run.includes("instrumented-candidate-home-diagnostic.jsonl"),
      ),
    ).toBe(true);
    const managedGatewayJson = JSON.stringify(managedGateway?.steps ?? []);
    expect(managedGatewayJson).toContain(
      "direct-candidate-home-diagnostic.jsonl",
    );
    expect(managedGatewayJson).toContain("direct-fake-home-diagnostic.jsonl");
    expect(managedGatewayJson).toContain(
      "instrumented-candidate-home-diagnostic.jsonl",
    );

    const runtimeHealth = workflow.jobs?.["windows-runtime-health-diagnostic"];
    expect(runtimeHealth).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.mode == 'windows-runtime-health-diagnostic'",
      name: "windows-runtime-health-diagnostic",
      "runs-on": "windows-2025",
      "timeout-minutes": 25,
    });
    // This lane is a bounded, credential-free evidence run and must stay
    // separate from required CI and all release/promotion jobs.
    expect(runtimeHealth?.environment).toBeUndefined();
    expect(JSON.stringify(runtimeHealth?.steps)).not.toContain("secrets.");
    expect(
      runtimeHealth?.steps?.some(
        (step) =>
          step.name === "Run extracted Runtime health lifecycle diagnostic" &&
          step.run?.includes("tests/runtime-health-diagnostics.test.ts") ===
            true,
      ),
    ).toBe(true);
    expect(
      runtimeHealth?.steps?.some(
        (step) =>
          step.name === "Upload Runtime health lifecycle evidence" &&
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.name ===
            "windows-runtime-health-diagnostic-${{ github.run_id }}",
      ),
    ).toBe(true);

    const packagedAcceptanceWorkflow = readFileSync(
      resolve(".github/workflows/beta38-windows-packaged-acceptance.yml"),
      "utf8",
    );
    expect(packagedAcceptanceWorkflow).toContain(
      "$env:AGENTERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT",
    );
    expect(packagedAcceptanceWorkflow).toContain(
      "$env:AGENTERA_E2E_GATEWAY_OBSERVER = $env:GATEWAY_OBSERVER",
    );
    expect(packagedAcceptanceWorkflow).toContain("default: enabled");
    expect(packagedAcceptanceWorkflow).toContain("- disabled");
    expect(packagedAcceptanceWorkflow).not.toContain(
      "$env:AERA_RUNTIME_INVENTORY_DIAGNOSTIC_OUTPUT",
    );
    expect(packagedAcceptanceWorkflow).toContain("test-results");
  });

  it("runs the managed Gateway diagnostic contract in ordinary platform CI", () => {
    const step = readWorkflow().jobs?.check?.steps?.find(
      (candidate) =>
        candidate.name === "Test managed Gateway diagnostic contract",
    );
    expect(step).toEqual({
      name: "Test managed Gateway diagnostic contract",
      run: "node --test scripts/diagnose-windows-serve-help.test.mjs",
    });
  });
});
