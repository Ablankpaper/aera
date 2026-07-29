export interface AgentCreationIntent {
  suggestedName: string;
  suggestedPurpose: string;
}

const CJK_CREATION =
  /(?:帮我|请|我要|我想|给我)?\s*(?:创建|新建|建立|生成|配置|做)(?:一个|个|一名)?/i;
const CJK_AGENT = /(?:智能体|智能助手|AI\s*助手)/i;
const EN_CREATION =
  /\b(?:create|build|make|configure|set up|new)\b[\s\S]{0,80}\b(?:agent|assistant)\b/i;
const QUESTION_PREFIX =
  /^\s*(?:(?:请|帮我)\s*)?(?:如何|怎么|怎样|为什么|介绍|解释|说明|分析|查找|搜索|how\b|why\b|what\b|explain\b|describe\b|show\s+me\s+how\b)/i;
const ALREADY_CREATED =
  /(?:已经|已|刚刚|刚才)\s*(?:创建|新建|建立)|(?:创建|新建|建立|生成)\s*(?:失败|成功|流程|教程|方法|问题|记录)|\b(?:already|just)\s+(?:created|built|made)\b/i;

function cleanCapture(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^[“”"'「」『』《》【】]+|[“”"'「」『』《》【】]+$/g, "")
    .replace(/[，。,.！!?；;：:]+$/g, "")
    .trim();
}

function extractName(text: string): string {
  const explicit =
    text.match(
      /(?:名字(?:叫|是)|名称(?:叫|是|为)|名为|叫做?)\s*[：:]?\s*[“"'「『]?([A-Za-z0-9_\-\u3400-\u9fff ]{1,40}?)[”"'」』]?(?=(?:的)?(?:智能体|智能助手|AI\s*助手)|[，。,.！!?；;]|$)/i,
    )?.[1] ??
    text.match(
      /(?:创建|新建|建立|生成|配置|做)(?:一个|个|一名)?\s*[“"'「『]?([A-Za-z0-9_\-\u3400-\u9fff]{1,30})[”"'」』]?\s*(?:智能体|智能助手|AI\s*助手)/i,
    )?.[1] ??
    text.match(
      /\b(?:agent|assistant)\s+(?:named|called)\s+[“"']?([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,5}?)[”"']?(?=\s+(?:to|for)\b|[.!?]|$)/i,
    )?.[1];
  const name = cleanCapture(explicit);
  return /^(?:新的?|一个|我的|企业|个人|专属)$/i.test(name) ? "" : name;
}

function extractPurpose(text: string): string {
  const cjk = text.match(
    /(?:负责|用于|用来|主要(?:负责|用来|做)|专门(?:负责|用来|做))\s*[：:]?\s*([^。！？!?]{2,160})/i,
  )?.[1];
  if (cjk) return cleanCapture(cjk);

  const english = text.match(
    /\b(?:agent|assistant)(?:\s+(?:named|called)\s+[A-Za-z0-9 _-]{1,40})?\s+(?:to|for)\s+([^.!?]{2,180})/i,
  )?.[1];
  return cleanCapture(english);
}

export function parseAgentCreationIntent(
  rawText: string,
): AgentCreationIntent | null {
  const text = rawText.normalize("NFC").trim();
  if (!text || text.length > 2_000) return null;
  if (QUESTION_PREFIX.test(text) || ALREADY_CREATED.test(text)) return null;

  const chineseIntent = CJK_CREATION.test(text) && CJK_AGENT.test(text);
  const englishIntent = EN_CREATION.test(text);
  if (!chineseIntent && !englishIntent) return null;

  return {
    suggestedName: extractName(text),
    suggestedPurpose: extractPurpose(text),
  };
}
