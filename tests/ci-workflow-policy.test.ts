import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
}

function unitTestSteps(): WorkflowStep[] {
  const raw = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const workflow = parseYaml(raw) as {
    jobs?: { check?: { steps?: WorkflowStep[] } };
  };
  return (workflow.jobs?.check?.steps ?? []).filter((step) =>
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
        run: "npm test -- --maxWorkers=1",
      },
    ]);
  });
});
