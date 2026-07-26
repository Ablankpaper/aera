import { isValidProfileName } from "../utils";
import type { AgenteraMemoryCandidateProposal } from "../../shared/agentera-memory-candidate";

const MAX_VALUE_CHARS = 40;

const CHINESE_IDENTITY_PATTERNS = [
  /(?:你的名字(?:是|叫)|你(?:以后|今后|从现在起)?(?:就)?(?:叫|名叫)|(?:给你|把你)(?:取名|起名)(?:为|叫)?|(?:当前|这个)(?:智能体|助手|agent)(?:以后|今后)?(?:就)?(?:叫|名叫|名字是))\s*[「『“"'《]?([^，。；;、,\n]+?)[」』”"'》]?(?=(?:[，。；;、,\n]|\s*(?:以后|今后|从现在起|并且|然后)|$))/iu,
] as const;

const ENGLISH_IDENTITY_PATTERNS = [
  /(?:call\s+yourself|your\s+name\s+is|you\s+are\s+(?:now\s+)?(?:called|named)|i(?:'ll|\s+will)\s+call\s+you)\s+[“"'「『]?([^,.;\n]+?)[”"'」』]?(?=(?:[,.;\n]|\s+(?:and|from\s+now\s+on)\b|$))/iu,
] as const;

const CHINESE_ADDRESS_PATTERNS = [
  /(?:以后|今后|从现在起|从今以后)\s*(?:请\s*)?(?:(?:所有(?:的)?(?:智能体|助手|agents?)|你们|大家)\s*)?(?:都\s*)?(?:请\s*)?(?:叫|称呼)\s*(?:我|用户)(?:为|作|做)?\s*[「『“"'《]?([^，。；;、,\n]+?)[」』”"'》]?(?=(?:[，。；;、,\n]|$))/iu,
  /(?:(?:所有(?:的)?(?:智能体|助手|agents?)|你们|大家)\s*)(?:以后|今后|从现在起)?\s*(?:都\s*)?(?:请\s*)?(?:叫|称呼)\s*(?:我|用户)(?:为|作|做)?\s*[「『“"'《]?([^，。；;、,\n]+?)[」』”"'》]?(?=(?:[，。；;、,\n]|$))/iu,
  /(?:请\s*)?称呼\s*(?:我|用户)(?:为|作|做)?\s*[「『“"'《]?([^，。；;、,\n]+?)[」』”"'》]?(?=(?:[，。；;、,\n]|$))/iu,
] as const;

const ENGLISH_ADDRESS_PATTERNS = [
  /(?:from\s+now\s+on\s*,?\s*)(?:please\s+)?(?:(?:all\s+)?agents?\s+)?(?:address|call)\s+me\s+(?:as\s+)?[“"'「『]?([^,.;\n]+?)[”"'」』]?(?=(?:[,.;\n]|$))/iu,
  /(?:please\s+)?address\s+me\s+as\s+[“"'「『]?([^,.;\n]+?)[”"'」』]?(?=(?:[,.;\n]|$))/iu,
] as const;

/**
 * Extract only explicit, high-confidence local proposals from the current
 * visible user text. This function performs no I/O and never returns or stores
 * the original transcript.
 */
export function extractExplicitMemoryCandidates(
  rawText: unknown,
  rawProfileId: unknown,
): AgenteraMemoryCandidateProposal[] {
  if (
    typeof rawText !== "string" ||
    typeof rawProfileId !== "string" ||
    !isValidProfileName(rawProfileId)
  ) {
    return [];
  }
  const text = rawText.normalize("NFKC").trim();
  if (!text || text.length > 4_000 || containsUnsafeText(text)) return [];

  const proposals: AgenteraMemoryCandidateProposal[] = [];
  const identity = firstBoundedMatch(text, [
    ...CHINESE_IDENTITY_PATTERNS,
    ...ENGLISH_IDENTITY_PATTERNS,
  ]);
  if (identity && !/^我/u.test(identity)) {
    proposals.push({
      kind: "agent_identity",
      profileId: rawProfileId,
      proposedDisplayName: identity,
      summary: `将当前 Agent 命名为“${identity}”`,
      confidence: 1,
    });
  }

  const preferredAddress = firstBoundedMatch(text, [
    ...CHINESE_ADDRESS_PATTERNS,
    ...ENGLISH_ADDRESS_PATTERNS,
  ]);
  if (preferredAddress) {
    proposals.push({
      kind: "global_profile",
      profileId: rawProfileId,
      proposedValue: preferredAddress,
      entry: {
        id: "communication_style.preferred_address",
        category: "communication_style",
        content: `Address the user as “${preferredAddress}”.`,
      },
      summary: `让所有 Agent 称呼用户为“${preferredAddress}”`,
      confidence: 1,
    });
  }

  return proposals;
}

function firstBoundedMatch(
  text: string,
  patterns: ReadonlyArray<RegExp>,
): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = normalizeCandidateValue(match?.[1]);
    if (value) return value;
  }
  return null;
}

function normalizeCandidateValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw
    .normalize("NFKC")
    .trim()
    .replace(/^[「『“"'《]+|[」』”"'》]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!value || Array.from(value).length > MAX_VALUE_CHARS) return null;
  if (containsUnsafeText(value)) return null;
  return value;
}

function containsUnsafeText(value: string): boolean {
  return (
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    /(?:ignore\s+(?:all|any|the|previous)\s+instructions?|system\s+prompt|developer\s+message|忽略.{0,12}(?:指令|提示)|系统提示|开发者消息)/iu.test(
      value,
    ) ||
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\b(?:api[ _-]?key|password|passwd|secret|bearer|access[ _-]?token|refresh[ _-]?token)\s*[:=]\s*\S{8,})/iu.test(
      value,
    )
  );
}
