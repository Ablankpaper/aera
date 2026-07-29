import { describe, expect, it } from "vitest";
import { parseAgentCreationIntent } from "./agentCreationIntent";

describe("parseAgentCreationIntent", () => {
  it("extracts a Chinese Agent name and purpose", () => {
    expect(
      parseAgentCreationIntent(
        "帮我创建一个叫林二的智能体，主要负责整理客户资料。",
      ),
    ).toEqual({
      suggestedName: "林二",
      suggestedPurpose: "整理客户资料",
    });
  });

  it("recognizes a minimal request and leaves missing fields for defaults", () => {
    expect(parseAgentCreationIntent("请创建一个智能体")).toEqual({
      suggestedName: "",
      suggestedPurpose: "",
    });
  });

  it("extracts English name and purpose", () => {
    expect(
      parseAgentCreationIntent(
        "Create an agent called Researcher to summarize scientific papers.",
      ),
    ).toEqual({
      suggestedName: "Researcher",
      suggestedPurpose: "summarize scientific papers",
    });
  });

  it.each([
    "如何创建智能体？",
    "请分析智能体创建流程",
    "刚刚创建的智能体在哪里？",
    "这个智能体创建失败了",
    "Explain how to create an agent",
  ])(
    "does not intercept an informational or historical message: %s",
    (text) => {
      expect(parseAgentCreationIntent(text)).toBeNull();
    },
  );
});
