import { parseDocument } from "yaml";
import type {
  ImageGenerationAspectRatio,
  ImageGenerationConfigDraft,
  ImageGenerationConfigStatus,
  ImageGenerationErrorCode,
  ImageGenerationFailure,
  ImageGenerationModelsResult,
  ImageGenerationPublicConfig,
  ImageGenerationQuality,
  ImageGenerationSaveResult,
  ImageGenerationTestResult,
} from "../shared/image-generation";
import {
  IMAGE_GENERATION_ASPECT_RATIOS,
  IMAGE_GENERATION_QUALITIES,
} from "../shared/image-generation";
import {
  getConfigValue,
  persistConfigWritePlan,
  planConfigDocumentWrite,
  planEnvValueWrite,
} from "./config";
import { getSecret, getSecretsProvider } from "./secrets";
import {
  requireManagedModelMutationValue,
  type ManagedModelMutationPort,
} from "./model-configuration-mutation-port";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-image-1";
const DEFAULT_QUALITY: ImageGenerationQuality = "medium";
const DEFAULT_ASPECT_RATIO: ImageGenerationAspectRatio = "square";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MODELS = 512;
const MAX_IMAGE_BASE64_LENGTH = 64 * 1024 * 1024;
const MAX_IMAGE_URL_LENGTH = 16 * 1024;
const IMAGE_MODEL_PATTERN = /(image|dall-e|flux|ideogram|recraft)/i;

interface ServiceDependencies {
  fetch?: typeof fetch;
  timeoutMs?: number;
  modelMutationPort?: ManagedModelMutationPort;
}

interface ValidatedRequest {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  quality: ImageGenerationQuality;
  aspectRatio: ImageGenerationAspectRatio;
}

function normalizedBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.toString().replace(/\/$/, "");
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function validateRequest(input: ImageGenerationConfigDraft): ValidatedRequest {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.enabled !== "boolean"
  ) {
    throw new Error("invalid_configuration");
  }
  const baseUrl = normalizedBaseUrl(input.baseUrl);
  if (!baseUrl) throw new Error("invalid_configuration");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > 512 || /[\0\r\n]/.test(model)) {
    throw new Error("invalid_configuration");
  }
  if (
    typeof input.apiKey !== "string" ||
    input.apiKey.length > 65_536 ||
    /[\0\r\n]/.test(input.apiKey)
  ) {
    throw new Error("invalid_configuration");
  }
  if (!isOneOf(input.quality, IMAGE_GENERATION_QUALITIES)) {
    throw new Error("invalid_configuration");
  }
  if (!isOneOf(input.aspectRatio, IMAGE_GENERATION_ASPECT_RATIOS)) {
    throw new Error("invalid_configuration");
  }
  return {
    enabled: input.enabled,
    baseUrl,
    apiKey: input.apiKey.trim(),
    model,
    quality: input.quality,
    aspectRatio: input.aspectRatio,
  };
}

function boolConfig(value: string | null, fallback: boolean): boolean {
  if (value === "false") return false;
  if (value === "true") return true;
  return fallback;
}

function configStatus(
  enabled: boolean,
  hasApiKey: boolean,
): ImageGenerationConfigStatus {
  if (!enabled) return "disabled" as const;
  return hasApiKey ? ("configured" as const) : ("credential_required" as const);
}

function resolvedApiKey(profile?: string, draftKey = ""): string {
  return (
    draftKey.trim() ||
    getSecret("IMAGE_GEN_OPENAI_API_KEY", profile) ||
    getSecret("OPENAI_API_KEY", profile) ||
    ""
  );
}

function savedBaseUrl(profile?: string): string | null {
  const configured = getConfigValue("image_gen.openai.base_url", profile);
  if (!configured) return DEFAULT_BASE_URL;
  return normalizedBaseUrl(configured);
}

function reusableApiKey(
  profile: string | undefined,
  baseUrl: string,
  draftKey: string,
): string {
  if (draftKey.trim()) return draftKey.trim();
  if (savedBaseUrl(profile) !== baseUrl) return "";
  return resolvedApiKey(profile);
}

function appendEndpoint(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
}

function sizeForAspectRatio(aspectRatio: ImageGenerationAspectRatio): string {
  if (aspectRatio === "landscape") return "1536x1024";
  if (aspectRatio === "portrait") return "1024x1536";
  return "1024x1024";
}

function failure(errorCode: ImageGenerationErrorCode): ImageGenerationFailure {
  return { success: false as const, errorCode };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError";
}

function validBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IMAGE_BASE64_LENGTH &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_IMAGE_URL_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.toString();
}

export function createImageGenerationConfigService(
  dependencies: ServiceDependencies = {},
): {
  get(profile?: string): ImageGenerationPublicConfig;
  save(
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ): Promise<ImageGenerationSaveResult>;
  discover(
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ): Promise<ImageGenerationModelsResult>;
  testGeneration(
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ): Promise<ImageGenerationTestResult>;
} {
  const fetcher = dependencies.fetch ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function get(profile?: string): ImageGenerationPublicConfig {
    const enabled = boolConfig(
      getConfigValue("image_gen.enabled", profile),
      true,
    );
    const hasApiKey = Boolean(resolvedApiKey(profile));
    const qualityValue = getConfigValue("image_gen.openai.quality", profile);
    const aspectValue = getConfigValue("image_gen.aspect_ratio", profile);
    const configuredBaseUrl = getConfigValue(
      "image_gen.openai.base_url",
      profile,
    );
    return {
      enabled,
      provider: "openai",
      baseUrl: normalizedBaseUrl(configuredBaseUrl) || DEFAULT_BASE_URL,
      model:
        getConfigValue("image_gen.openai.model", profile) ||
        getConfigValue("image_gen.model", profile) ||
        DEFAULT_MODEL,
      quality: isOneOf(qualityValue, IMAGE_GENERATION_QUALITIES)
        ? qualityValue
        : DEFAULT_QUALITY,
      aspectRatio: isOneOf(aspectValue, IMAGE_GENERATION_ASPECT_RATIOS)
        ? aspectValue
        : DEFAULT_ASPECT_RATIO,
      hasApiKey,
      status: configStatus(enabled, hasApiKey),
    };
  }

  async function save(
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ): Promise<ImageGenerationSaveResult> {
    let validated: ValidatedRequest;
    try {
      validated = validateRequest(request);
    } catch {
      return failure("invalid_configuration");
    }

    if (validated.apiKey && getSecretsProvider(profile).id === "command") {
      return failure("secret_provider_read_only");
    }

    if (
      !validated.apiKey &&
      resolvedApiKey(profile) &&
      savedBaseUrl(profile) !== validated.baseUrl
    ) {
      return failure("credential_required");
    }

    if (!dependencies.modelMutationPort) {
      throw new Error("model_configuration_mutation_unavailable");
    }
    let configPlan: ReturnType<typeof planConfigDocumentWrite<void>>;
    try {
      configPlan = planConfigDocumentWrite(
        profile,
        (content) => {
          const document = parseDocument(content);
          if (document.errors.length > 0) {
            throw new Error("invalid image generation YAML");
          }
          document.setIn(["image_gen", "enabled"], validated.enabled);
          document.setIn(["image_gen", "provider"], "openai");
          document.setIn(["image_gen", "model"], validated.model);
          document.setIn(["image_gen", "aspect_ratio"], validated.aspectRatio);
          document.setIn(
            ["image_gen", "openai", "base_url"],
            validated.baseUrl,
          );
          document.setIn(["image_gen", "openai", "model"], validated.model);
          document.setIn(["image_gen", "openai", "quality"], validated.quality);
          return document.toString();
        },
        undefined,
      );
    } catch {
      return failure("write_failed");
    }
    const credentialPlan = validated.apiKey
      ? planEnvValueWrite("IMAGE_GEN_OPENAI_API_KEY", validated.apiKey, profile)
      : null;
    const result = await dependencies.modelMutationPort.mutate({
      operation: "image_generation_config_save",
      globalCatalog: false,
      profileIds: [profile || "default"],
      stage: credentialPlan ? "credential" : "activation",
      prepare: () => ({
        write: (permit) => {
          if (credentialPlan) persistConfigWritePlan(permit, credentialPlan);
          persistConfigWritePlan(permit, configPlan);
        },
      }),
    });
    requireManagedModelMutationValue(result);
    return { success: true, config: get(profile) };
  }

  async function requestJson(
    url: string,
    init: RequestInit,
  ): Promise<
    | { success: true; body: unknown }
    | { success: false; errorCode: ImageGenerationErrorCode }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) return failure("upstream_rejected");
      try {
        return { success: true, body: await response.json() };
      } catch {
        return failure("invalid_response");
      }
    } catch (error) {
      return failure(
        isAbortError(error) ? "request_timeout" : "network_unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function networkSettings(
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ):
    | { success: true; settings: ValidatedRequest & { apiKey: string } }
    | { success: false; errorCode: ImageGenerationErrorCode } {
    let settings: ValidatedRequest;
    try {
      settings = validateRequest(request);
    } catch {
      return failure("invalid_configuration");
    }
    const apiKey = reusableApiKey(profile, settings.baseUrl, settings.apiKey);
    if (!apiKey) return failure("credential_required");
    return { success: true, settings: { ...settings, apiKey } };
  }

  async function discover(
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ): Promise<ImageGenerationModelsResult> {
    const resolved = networkSettings(profile, request);
    if (!resolved.success) return resolved;
    const { settings } = resolved;
    const response = await requestJson(
      appendEndpoint(settings.baseUrl, "models"),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      },
    );
    if (!response.success) return response;
    const body = response.body as { data?: unknown };
    if (!Array.isArray(body?.data) || body.data.length > MAX_MODELS) {
      return failure("invalid_response");
    }
    const models = body.data
      .map((item) =>
        item && typeof item === "object" && "id" in item ? item.id : null,
      )
      .filter(
        (id): id is string =>
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= 512 &&
          !/[\0\r\n]/.test(id) &&
          IMAGE_MODEL_PATTERN.test(id),
      )
      .sort();
    return { success: true, models: [...new Set(models)] };
  }

  async function testGeneration(
    profile: string | undefined,
    request: ImageGenerationConfigDraft,
  ): Promise<ImageGenerationTestResult> {
    const resolved = networkSettings(profile, request);
    if (!resolved.success) return resolved;
    const { settings } = resolved;
    const response = await requestJson(
      appendEndpoint(settings.baseUrl, "images/generations"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: settings.model,
          prompt: "A simple Aera image generation connection test",
          quality: settings.quality,
          size: sizeForAspectRatio(settings.aspectRatio),
          n: 1,
        }),
      },
    );
    if (!response.success) return response;
    const body = response.body as {
      data?: Array<{ b64_json?: unknown; url?: unknown }>;
    };
    const image = body?.data?.[0];
    if (validBase64(image?.b64_json)) {
      return {
        success: true,
        imageUrl: `data:image/png;base64,${image.b64_json}`,
      };
    }
    const imageUrl = safeImageUrl(image?.url);
    if (!imageUrl) return failure("invalid_response");
    return { success: true, imageUrl };
  }

  return { get, save, discover, testGeneration };
}

export type ImageGenerationConfigService = ReturnType<
  typeof createImageGenerationConfigService
>;

export const imageGenerationConfigService =
  createImageGenerationConfigService();
