export const IMAGE_GENERATION_QUALITIES = ["low", "medium", "high"] as const;
export type ImageGenerationQuality =
  (typeof IMAGE_GENERATION_QUALITIES)[number];

export const IMAGE_GENERATION_ASPECT_RATIOS = [
  "landscape",
  "square",
  "portrait",
] as const;
export type ImageGenerationAspectRatio =
  (typeof IMAGE_GENERATION_ASPECT_RATIOS)[number];

export type ImageGenerationConfigStatus =
  | "configured"
  | "credential_required"
  | "disabled";

export type ImageGenerationErrorCode =
  | "invalid_configuration"
  | "credential_required"
  | "request_timeout"
  | "network_unavailable"
  | "upstream_rejected"
  | "invalid_response"
  | "write_failed"
  | "secret_provider_read_only"
  | "remote_unsupported";

export interface ImageGenerationPublicConfig {
  enabled: boolean;
  provider: "openai";
  baseUrl: string;
  model: string;
  quality: ImageGenerationQuality;
  aspectRatio: ImageGenerationAspectRatio;
  hasApiKey: boolean;
  status: ImageGenerationConfigStatus;
}

export interface ImageGenerationConfigDraft {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  quality: ImageGenerationQuality;
  aspectRatio: ImageGenerationAspectRatio;
}

export interface ImageGenerationConfigSuccess {
  success: true;
  config: ImageGenerationPublicConfig;
}

export interface ImageGenerationFailure {
  success: false;
  errorCode: ImageGenerationErrorCode;
}

export type ImageGenerationConfigReadResult =
  | ImageGenerationConfigSuccess
  | ImageGenerationFailure;

export type ImageGenerationSaveResult =
  | ImageGenerationConfigSuccess
  | ImageGenerationFailure;

export type ImageGenerationModelsResult =
  | { success: true; models: string[] }
  | ImageGenerationFailure;

export type ImageGenerationTestResult =
  | { success: true; imageUrl: string }
  | ImageGenerationFailure;
