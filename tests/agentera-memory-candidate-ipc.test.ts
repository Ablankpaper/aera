// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const registerPath = join(ROOT, "src/main/ipc/register.ts");
const registerSourceText = readFileSync(registerPath, "utf8");
const registerSource = ts.createSourceFile(
  registerPath,
  registerSourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function handler(channel: string): ts.ArrowFunction | ts.FunctionExpression {
  let found: ts.ArrowFunction | ts.FunctionExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(registerSource) === "ipcMain" &&
      node.expression.name.text === "handle" &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === channel &&
      (ts.isArrowFunction(node.arguments[1]) ||
        ts.isFunctionExpression(node.arguments[1]))
    ) {
      found = node.arguments[1];
    }
    ts.forEachChild(node, visit);
  };
  visit(registerSource);
  if (!found) throw new Error(`missing IPC handler: ${channel}`);
  return found;
}

describe("AgentEra natural-language memory-candidate IPC", () => {
  it("derives the account in main and accepts only text plus an Agent Profile target", () => {
    const node = handler("agentera-memory-candidates-extract");
    expect(
      node.parameters.map((parameter) => parameter.name.getText()),
    ).toEqual(["_event", "rawText", "profile"]);
    const source = node.getText(registerSource);
    expect(source).toContain("currentAgenteraUserId()");
    expect(source).toContain("agenteraMemoryCandidates.extract");
    expect(source).not.toMatch(/rendererUserId|rawUserId|input\.userId/);
  });

  it("confirms and rejects only through the main-derived account and explicit Agent target", () => {
    for (const [channel, method] of [
      ["agentera-memory-candidates-confirm", "confirm"],
      ["agentera-memory-candidates-reject", "reject"],
    ] as const) {
      const node = handler(channel);
      expect(
        node.parameters.map((parameter) => parameter.name.getText()),
      ).toEqual(["_event", "batchId", "profile"]);
      const source = node.getText(registerSource);
      expect(source).toContain("currentAgenteraUserId()");
      expect(source).toContain(`agenteraMemoryCandidateConfirmation.${method}`);
      expect(source).not.toMatch(/rendererUserId|rawUserId|input\.userId/);
    }
  });

  it("constructs candidate storage beside the global profile and injects it into IPC", () => {
    const startSource = readFileSync(
      join(ROOT, "src/main/app/start.ts"),
      "utf8",
    );
    expect(startSource).toContain("new AgenteraMemoryCandidateManager");
    expect(startSource).toContain(
      "new AgenteraMemoryCandidateConfirmationCoordinator",
    );
    expect(startSource).toMatch(
      /registerIpcHandlers\([\s\S]*agenteraMemoryCandidates,[\s\S]*agenteraMemoryCandidateConfirmation,/,
    );
  });
});
