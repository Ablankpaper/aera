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
  it("runs Windows unit tests with one worker", () => {
    expect(unitTestSteps()).toContainEqual({
      name: "Test unit (Windows serial)",
      if: "matrix.os == 'windows-latest'",
      run: "npm test -- --maxWorkers=1",
    });
  });

  it("keeps two unit-test workers on non-Windows runners", () => {
    expect(unitTestSteps()).toContainEqual({
      name: "Test unit (non-Windows)",
      if: "matrix.os != 'windows-latest'",
      run: "npm test -- --maxWorkers=2",
    });
  });
});
