import type { AppLocale } from "./types";

export const SOURCE_LOCALE: AppLocale = "en";
export const FALLBACK_LOCALE: AppLocale = "en";
export const DEFAULT_ACTIVE_LOCALE: AppLocale = "en";
export const APP_LOCALES: AppLocale[] = [
  "en",
  "ar",
  "es",
  "he",
  "id",
  "ja",
  "pl",
  "pt-BR",
  "pt-PT",
  "tr",
  "zh-CN",
  "zh-TW",
];

// Locales that render right-to-left. Used to set the document's `dir`
// attribute so the whole UI mirrors for these languages.
export const RTL_LOCALES: AppLocale[] = ["ar", "he"];

export type TextDirection = "ltr" | "rtl";

export function resolveSystemLocale(rawLocale?: string): AppLocale {
  const normalized = (rawLocale ?? "")
    .trim()
    .replaceAll("_", "-")
    .split(".")[0]
    .toLowerCase();
  if (normalized.startsWith("zh")) {
    return /(?:^|-)hant(?:-|$)|-(?:tw|hk|mo)(?:-|$)/.test(normalized)
      ? "zh-TW"
      : "zh-CN";
  }
  if (normalized.startsWith("pt-br")) return "pt-BR";
  if (normalized.startsWith("pt")) return "pt-PT";

  for (const locale of APP_LOCALES) {
    const candidate = locale.toLowerCase();
    if (normalized === candidate || normalized.startsWith(`${candidate}-`)) {
      return locale;
    }
  }
  return DEFAULT_ACTIVE_LOCALE;
}

export function getLocaleDirection(locale: AppLocale): TextDirection {
  return RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
}
