# System locale selection

AgentEra Studio follows the operating-system language on first use while preserving every language choice the user explicitly saves.

## Locale precedence

A persisted desktop preference always wins. When no preference exists, the main process resolves Electron's system locale through [[src/shared/i18n/config.ts#resolveSystemLocale]] before [[src/main/locale.ts#getAppLocale]] exposes the active language.

The renderer applies the same rule through [[src/renderer/src/components/I18nProvider.tsx#I18nProvider]]: a stored browser preference wins, otherwise `navigator.language` selects the initial locale. Changing the language writes the preference, so later launches do not follow subsequent operating-system changes.

## Locale normalization

System locale values may contain region, script, underscore, or encoding suffixes. The resolver normalizes those platform-specific forms into supported product locales.

Chinese Simplified variants map to `zh-CN`, Chinese Traditional variants map to `zh-TW`, Brazilian Portuguese maps to `pt-BR`, other Portuguese variants map to `pt-PT`, and supported base languages ignore unrelated region suffixes.

Unknown or empty system locales fall back to the product's default active locale.
