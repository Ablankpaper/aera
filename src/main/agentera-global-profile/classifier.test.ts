import { describe, expect, it } from "vitest";
import { extractExplicitMemoryCandidates } from "./classifier";

describe("explicit natural-language memory candidate classifier", () => {
  it("splits one Chinese message into an Agent identity and account-wide address candidate", () => {
    const result = extractExplicitMemoryCandidates(
      "从今天起，你的名字是「青岚」，以后请称呼我为“馆长”。",
      "vertical-agent-one",
    );

    expect(result).toEqual([
      {
        kind: "agent_identity",
        profileId: "vertical-agent-one",
        proposedDisplayName: "青岚",
        summary: "将当前 Agent 命名为“青岚”",
        confidence: 1,
      },
      {
        kind: "global_profile",
        profileId: "vertical-agent-one",
        proposedValue: "馆长",
        entry: {
          id: "communication_style.preferred_address",
          category: "communication_style",
          content: "Address the user as “馆长”.",
        },
        summary: "让所有 Agent 称呼用户为“馆长”",
        confidence: 1,
      },
    ]);
  });

  it("supports equivalent explicit English directives without hardcoded values", () => {
    const result = extractExplicitMemoryCandidates(
      "Call yourself North Star, and from now on address me as Captain.",
      "vertical-agent-two",
    );

    expect(result.map((candidate) => candidate.kind)).toEqual([
      "agent_identity",
      "global_profile",
    ]);
    expect(result[0]).toMatchObject({ proposedDisplayName: "North Star" });
    expect(result[1]).toMatchObject({ proposedValue: "Captain" });
  });

  it("does not classify ordinary chat or a Chinese phrase where 叫 means ask", () => {
    expect(
      extractExplicitMemoryCandidates(
        "请帮我分析这份代码，但先不要修改。",
        "vertical-agent-one",
      ),
    ).toEqual([]);
    expect(
      extractExplicitMemoryCandidates(
        "你叫我看看这个功能有没有问题。",
        "vertical-agent-one",
      ),
    ).toEqual([]);
  });

  it("drops unbounded values and never returns the original transcript", () => {
    const raw = `你的名字是${"甲".repeat(80)}，以后称呼我为${"乙".repeat(80)}`;
    const result = extractExplicitMemoryCandidates(raw, "vertical-agent-one");

    expect(result).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(raw);
  });
});
