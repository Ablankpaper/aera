export type ModelApiMode =
  | "chat_completions"
  | "codex_responses"
  | "anthropic_messages"
  | "bedrock_converse"
  | "codex_app_server";

export interface ModelProviderPreset {
  id: string;
  label: string;
  envKey: string;
  provider: string;
  baseUrl: string;
  apiMode?: ModelApiMode;
  keyOptional?: boolean;
}

/**
 * Product-facing provider presets.
 *
 * These values mirror the provider registry shipped by aera-runtime. The
 * renderer intentionally owns this small presentation registry so the common
 * setup path can fill routing details for the user instead of asking them to
 * research provider slugs, endpoints, or environment-variable names.
 */
export const MODEL_PROVIDER_PRESETS: ReadonlyArray<ModelProviderPreset> = [
  {
    id: "petoi",
    label: "Petoi",
    envKey: "PETOI_API_KEY",
    provider: "custom",
    baseUrl: "https://api.petoi.cn/v1",
    apiMode: "chat_completions",
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    provider: "custom",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiMode: "anthropic_messages",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    provider: "custom",
    baseUrl: "https://api.deepseek.com/v1",
    apiMode: "chat_completions",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    id: "alibaba",
    label: "Alibaba Cloud Model Studio",
    envKey: "DASHSCOPE_API_KEY",
    provider: "alibaba",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "google",
    label: "Google AI Studio",
    envKey: "GOOGLE_API_KEY",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    id: "xai",
    label: "xAI",
    envKey: "XAI_API_KEY",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
  },
  {
    id: "zai",
    label: "Z.AI / GLM",
    envKey: "GLM_API_KEY",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/paas/v4",
  },
  {
    id: "kimi-coding",
    label: "Kimi / Moonshot",
    envKey: "KIMI_API_KEY",
    provider: "kimi-coding",
    baseUrl: "https://api.moonshot.ai/v1",
  },
  {
    id: "minimax",
    label: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    provider: "minimax",
    baseUrl: "https://api.minimax.io/anthropic",
    apiMode: "anthropic_messages",
  },
  {
    id: "minimax-cn",
    label: "MiniMax (China)",
    envKey: "MINIMAX_CN_API_KEY",
    provider: "minimax-cn",
    baseUrl: "https://api.minimaxi.com/anthropic",
    apiMode: "anthropic_messages",
  },
  {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    provider: "custom",
    baseUrl: "https://api.groq.com/openai/v1",
    apiMode: "chat_completions",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    envKey: "OLLAMA_API_KEY",
    provider: "ollama-cloud",
    baseUrl: "https://ollama.com/v1",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    envKey: "NVIDIA_API_KEY",
    provider: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    envKey: "HF_TOKEN",
    provider: "huggingface",
    baseUrl: "https://router.huggingface.co/v1",
  },
  {
    id: "mistral",
    label: "Mistral",
    envKey: "MISTRAL_API_KEY",
    provider: "custom",
    baseUrl: "https://api.mistral.ai/v1",
    apiMode: "chat_completions",
  },
  {
    id: "together",
    label: "Together AI",
    envKey: "TOGETHER_API_KEY",
    provider: "custom",
    baseUrl: "https://api.together.xyz/v1",
    apiMode: "chat_completions",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    envKey: "FIREWORKS_API_KEY",
    provider: "custom",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiMode: "chat_completions",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    provider: "custom",
    baseUrl: "https://api.cerebras.ai/v1",
    apiMode: "chat_completions",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    envKey: "PERPLEXITY_API_KEY",
    provider: "custom",
    baseUrl: "https://api.perplexity.ai",
    apiMode: "chat_completions",
  },
  {
    id: "aimlapi",
    label: "AIML API",
    envKey: "AIMLAPI_API_KEY",
    provider: "custom",
    baseUrl: "https://api.aimlapi.com/v1",
    apiMode: "chat_completions",
  },
  {
    id: "atlascloud",
    label: "AtlasCloud",
    envKey: "ATLASCLOUD_API_KEY",
    provider: "custom",
    baseUrl: "https://api.atlascloud.ai/v1",
    apiMode: "chat_completions",
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    envKey: "XIAOMI_API_KEY",
    provider: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    envKey: "OPENCODE_ZEN_API_KEY",
    provider: "opencode-zen",
    baseUrl: "https://opencode.ai/zen/v1",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    envKey: "OPENCODE_GO_API_KEY",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
  },
  {
    id: "hermesone",
    label: "Hermes One",
    envKey: "HERMESONE_API_KEY",
    provider: "custom",
    baseUrl: "https://inference.hermesone.org/v1",
    apiMode: "chat_completions",
  },
  {
    id: "nous",
    label: "Nous Portal",
    envKey: "NOUS_API_KEY",
    provider: "nous",
    baseUrl: "https://inference-api.nousresearch.com/v1",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    envKey: "",
    provider: "lmstudio",
    baseUrl: "http://localhost:1234/v1",
    keyOptional: true,
  },
  {
    id: "ollama",
    label: "Ollama (Local)",
    envKey: "",
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    keyOptional: true,
  },
  {
    id: "vllm",
    label: "vLLM",
    envKey: "",
    provider: "vllm",
    baseUrl: "http://localhost:8000/v1",
    keyOptional: true,
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    envKey: "",
    provider: "llamacpp",
    baseUrl: "http://localhost:8080/v1",
    keyOptional: true,
  },
];

const normalizedUrl = (value: string): string =>
  value.trim().replace(/\/+$/, "").toLowerCase();

export function findModelProviderPreset(
  id: string,
): ModelProviderPreset | undefined {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function findPresetForConfig(
  provider: string,
  baseUrl: string,
): ModelProviderPreset | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedBaseUrl = normalizedUrl(baseUrl);
  if (normalizedBaseUrl) {
    const urlMatch = MODEL_PROVIDER_PRESETS.find(
      (preset) => normalizedUrl(preset.baseUrl) === normalizedBaseUrl,
    );
    if (urlMatch) return urlMatch;
    // A concrete custom endpoint that does not match a preset must remain
    // custom. Falling through to `preset.provider === "custom"` would pick the
    // first generic preset (currently Petoi) and mark two services as active.
    if (normalizedProvider === "custom") return undefined;
  }
  return MODEL_PROVIDER_PRESETS.find(
    (preset) =>
      preset.id === normalizedProvider ||
      (normalizedProvider !== "custom" &&
        preset.provider === normalizedProvider),
  );
}
