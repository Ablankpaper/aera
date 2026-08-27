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
      options: ["full", "windows-process-tree-diagnostic", "windows-serve-help-diagnostic"],
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

    const serveHelp = workflow.jobs?.["windows-serve-help-diagnostic"];
    expect(serveHelp).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.mode == 'windows-serve-help-diagnostic'",
      name: "windows-serve-help-diagnostic",
      "runs-on": "windows-latest",
    });
    // Dispatch-only and credential-free: no environment, no secrets, and no
    // release/deploy steps can follow from a diagnostic run.
    expect(serveHelp?.environment).toBeUndefined();
    expect(JSON.stringify(serveHelp?.steps)).not.toContain("secrets.");
  });
});
